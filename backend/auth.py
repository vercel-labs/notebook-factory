"""Sign in with Vercel: authorization code + PKCE, verified OIDC identity."""
import base64
import hashlib
import os
import secrets
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select

from accounts import enroll, from_session
from config import SECRET, chat_model, served_origin, trusted_origin
from db import engine, notebooks

router = APIRouter(prefix="/api/auth")
signer = URLSafeTimedSerializer(SECRET)
COOKIE = "nf_session"
SESSION_SALT = "vercel-session"
FLOW_COOKIE = "nf_vercel_oauth"
ISSUER = "https://vercel.com"
AUTHORIZE_URL = ISSUER + "/oauth/authorize"
TOKEN_URL = "https://api.vercel.com/login/oauth/token"
JWKS_URL = ISSUER + "/.well-known/jwks"


def user(request: Request):
    try:
        value = signer.loads(request.cookies.get(COOKIE, ""), salt=SESSION_SALT, max_age=604800)
        if isinstance(value, dict) and value.get("provider") == "vercel" and isinstance(value.get("sub"), str) and value["sub"]:
            return value
    except BadSignature:
        pass
    return None


async def require_user(request: Request):
    current = user(request)
    if not current:
        raise HTTPException(401, "Sign in with Vercel first")
    if not trusted_origin(request.headers.get("origin")):
        raise HTTPException(403, "Invalid request origin")
    return await from_session(current)


async def require_owner(request: Request):
    return await _owner(request, await require_user(request))


async def require_owner_read(request: Request):
    """Owner check for read-only GETs, which browsers send without an Origin header."""
    current = user(request)
    if not current:
        raise HTTPException(401, "Sign in with Vercel first")
    return await _owner(request, await from_session(current))


async def _owner(request: Request, current):
    id = request.path_params.get("id")
    if id:
        async with engine.connect() as conn:
            owner_id = await conn.scalar(select(notebooks.c.owner_id).where(notebooks.c.id == id))
        if owner_id is None:
            raise HTTPException(404, "Notebook not found")
        if owner_id != current["id"]:
            raise HTTPException(403, "Only the notebook owner can edit it. Fork it to make your own copy.")
    return current


def cookie(request, response, name, value, age):
    response.set_cookie(
        name, value, max_age=age, httponly=True, secure=served_origin(request).startswith("https://"),
        samesite="lax", path="/",
    )


def credentials():
    client_id = os.getenv("VERCEL_APP_CLIENT_ID", "")
    secret = os.getenv("VERCEL_APP_CLIENT_SECRET", "")
    if not client_id or not secret:
        raise HTTPException(503, "Configure Sign in with Vercel credentials")
    return client_id, secret


@router.get("/me")
async def me(request: Request):
    current = user(request)
    if current:
        account = await from_session(current)
        current = {"id": account["vercel_id"], "user_id": account["id"], "login": account["login"], "avatar_url": account["avatar_url"]}
    return {
        "user": current, "chat_model": chat_model(), "can_edit": bool(current),
        "configured": bool(os.getenv("VERCEL_APP_CLIENT_ID") and os.getenv("VERCEL_APP_CLIENT_SECRET")),
    }


@router.get("/login")
async def login(request: Request):
    client_id, _ = credentials()
    flow = {key: secrets.token_urlsafe(32) for key in ("state", "nonce", "verifier")}
    # Return to the deployment that started sign-in. The Vercel App's project callback accepts
    # every deployment domain; the token exchange must repeat this exact redirect_uri.
    flow["redirect_uri"] = served_origin(request) + "/api/auth/callback"
    challenge = base64.urlsafe_b64encode(hashlib.sha256(flow["verifier"].encode()).digest()).rstrip(b"=").decode()
    response = RedirectResponse(AUTHORIZE_URL + "?" + urlencode({
        "client_id": client_id, "redirect_uri": flow["redirect_uri"],
        "response_type": "code", "scope": "openid profile",
        "state": flow["state"], "nonce": flow["nonce"],
        "code_challenge": challenge, "code_challenge_method": "S256",
    }))
    cookie(request, response, FLOW_COOKIE, signer.dumps(flow, salt="vercel-oauth"), 600)
    return response


async def verify_identity(client, id_token, client_id, nonce):
    """Use only Vercel's fixed JWKS endpoint; token-supplied URLs are never trusted."""
    try:
        header = jwt.get_unverified_header(id_token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise ValueError()
        response = await client.get(JWKS_URL)
        response.raise_for_status()
        keys = response.json()["keys"]
        key = next(key for key in keys if key.get("kid") == header["kid"] and key.get("kty") == "RSA" and key.get("use", "sig") == "sig")
        signing_key = jwt.PyJWK.from_dict(key, algorithm="RS256").key
        claims = jwt.decode(
            id_token, signing_key, algorithms=["RS256"], issuer=ISSUER, audience=client_id,
            leeway=30, options={"require": ["iss", "aud", "sub", "exp", "iat", "nonce"]},
        )
        if not isinstance(claims["nonce"], str) or not secrets.compare_digest(claims["nonce"], nonce):
            raise ValueError()
        if claims.get("azp", client_id) != client_id:
            raise ValueError()
        if isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and claims.get("azp") != client_id:
            raise ValueError()
        return claims
    except (jwt.PyJWTError, ValueError, KeyError, TypeError, StopIteration):
        raise HTTPException(400, "Could not verify your Vercel identity. Please sign in again.") from None


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    try:
        try:
            flow = signer.loads(request.cookies.get(FLOW_COOKIE, ""), salt="vercel-oauth", max_age=600)
            if not isinstance(flow, dict) or not state or not secrets.compare_digest(state, flow["state"]):
                raise ValueError()
            if not all(isinstance(flow.get(key), str) and flow[key] for key in ("nonce", "verifier", "redirect_uri")):
                raise ValueError()
        except (BadSignature, ValueError, KeyError, TypeError):
            raise HTTPException(400, "Invalid or expired sign-in state. Please try again.") from None
        if error:
            message = {
                "access_denied": "Vercel sign-in was declined. Please try again.",
                "invalid_request": "Vercel rejected the sign-in request (invalid_request). Check the app authentication configuration.",
                "invalid_scope": "Vercel rejected the requested sign-in scopes (invalid_scope). Enable openid and profile.",
            }.get(error, "Vercel returned a sign-in error. Please try again.")
            raise HTTPException(400, message)
        if not code:
            raise HTTPException(400, "Missing authorization code")
        client_id, client_secret = credentials()
        async with httpx.AsyncClient(timeout=20) as client:
            token = await client.post(TOKEN_URL, data={
                "grant_type": "authorization_code", "client_id": client_id,
                "client_secret": client_secret, "code": code, "code_verifier": flow["verifier"],
                "redirect_uri": flow["redirect_uri"],
            })
            if token.status_code != 200:
                raise HTTPException(400, "Vercel sign-in failed. Please try again.")
            data = token.json()
            if not isinstance(data, dict) or not isinstance(data.get("id_token"), str):
                raise HTTPException(400, "Vercel did not return a valid identity token")
            identity = await verify_identity(client, data["id_token"], client_id, flow["nonce"])
        account = await enroll(identity)
        response = RedirectResponse("/", status_code=303)
        cookie(request, response, COOKIE, signer.dumps({"provider": "vercel", "sub": account["vercel_id"]}, salt=SESSION_SALT), 604800)
    except (httpx.HTTPError, ValueError):
        response = JSONResponse({"detail": "Vercel sign-in is temporarily unavailable. Please try again."}, status_code=502)
    except HTTPException as failure:
        response = JSONResponse({"detail": failure.detail}, status_code=failure.status_code)
    response.delete_cookie(FLOW_COOKIE, path="/")
    return response


@router.post("/logout")
async def logout(request: Request):
    if not trusted_origin(request.headers.get("origin")):
        raise HTTPException(403, "Invalid request origin")
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(COOKIE, path="/")
    response.delete_cookie(FLOW_COOKIE, path="/")
    return response
