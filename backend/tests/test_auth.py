import base64
import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

import auth
import main


@pytest.fixture
def oauth(monkeypatch):
    monkeypatch.setenv('VERCEL_APP_CLIENT_ID', 'test-client')
    monkeypatch.setenv('VERCEL_APP_CLIENT_SECRET', 'test-secret')
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid='test-key', use='sig')
    state = {'key': key, 'jwk': jwk, 'overrides': {}, 'requests': []}
    real_client = httpx.AsyncClient

    def handler(request):
        state['requests'].append(request)
        if str(request.url) == auth.JWKS_URL:
            return httpx.Response(200, json={'keys': [jwk]})
        assert str(request.url) == auth.TOKEN_URL
        now = int(time.time())
        claims = dict(iss=auth.ISSUER, aud='test-client', sub='oauth-test-user',
                      exp=now + 300, iat=now, nonce=state['nonce'],
                      preferred_username='oauth-user', picture='https://example.com/avatar.png')
        claims.update(state['overrides'])
        token = jwt.encode(claims, state.get('signing_key', key), algorithm='RS256', headers={'kid': 'test-key'})
        return httpx.Response(200, json={'id_token': token, 'access_token': 'never-store-this'})

    monkeypatch.setattr(auth.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler)))
    with TestClient(main.app) as client:
        response = client.get('/api/auth/login', follow_redirects=False)
        state['params'] = parse_qs(urlsplit(response.headers['location']).query)
        state['nonce'] = state['params']['nonce'][0]
        state['flow'] = auth.signer.loads(client.cookies.get(auth.FLOW_COOKIE), salt='vercel-oauth')
        state['client'] = client
        yield state


def finish(flow_state, **params):
    return flow_state['client'].get('/api/auth/callback', params={
        'code': 'test-code', 'state': flow_state['params']['state'][0], **params,
    }, follow_redirects=False)


# @lat: [[architecture#Vercel sign-in tests]]
def test_pkce_callback_and_session(oauth):
    params, flow = oauth['params'], oauth['flow']
    assert params['scope'] == ['openid profile']
    assert 'response_mode' not in params
    assert params['code_challenge_method'] == ['S256']
    challenge = base64.urlsafe_b64encode(hashlib.sha256(flow['verifier'].encode()).digest()).rstrip(b'=').decode()
    assert params['code_challenge'] == [challenge]
    assert finish(oauth).status_code == 303
    payload = parse_qs(oauth['requests'][0].content.decode())
    assert payload['code_verifier'] == [flow['verifier']]
    assert payload['client_secret'] == ['test-secret']
    client = oauth['client']
    session = auth.signer.loads(client.cookies.get(auth.COOKIE), salt=auth.SESSION_SALT)
    assert session == {'provider': 'vercel', 'sub': 'oauth-test-user'}
    assert auth.FLOW_COOKIE not in client.cookies
    me = client.get('/api/auth/me').json()
    assert me['can_edit'] and me['user']['login'] == 'oauth-user'
    assert me['user']['avatar_url'] == 'https://example.com/avatar.png'
    assert finish(oauth).status_code == 400


@pytest.mark.parametrize('overrides', [
    {'iss': 'https://attacker.example'}, {'aud': 'another-app'},
    {'nonce': 'wrong'}, {'exp': 1}, {'azp': 'another-app'}, {'sub': ''},
])
def test_invalid_identity_rejected(oauth, overrides):
    oauth['overrides'] = overrides
    assert finish(oauth).status_code in (400, 401)
    assert auth.COOKIE not in oauth['client'].cookies


def test_invalid_signature_rejected(oauth):
    oauth['signing_key'] = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert finish(oauth).status_code == 400
    assert auth.COOKIE not in oauth['client'].cookies


@pytest.mark.parametrize('params', [{'state': 'wrong'}, {'error': 'access_denied'}, {'code': ''}])
def test_failed_flow_never_exchanges_code(oauth, params):
    assert finish(oauth, **params).status_code == 400
    assert not oauth['requests']


def test_github_session_no_longer_authenticates(oauth):
    client = oauth['client']
    client.cookies.set(auth.COOKIE, auth.signer.dumps({'login': '1st1', 'id': 1}, salt='session'))
    assert client.get('/api/auth/me').json()['can_edit'] is False


def test_provider_configuration_error_is_not_reported_as_denied(oauth):
    response = finish(oauth, error='invalid_request')
    assert response.status_code == 400
    assert 'invalid_request' in response.json()['detail']
    assert 'declined' not in response.json()['detail']
    assert not oauth['requests']


# @lat: [[architecture#Vercel sign-in tests#Preview deployments sign in on their own origin]]
def test_preview_deployment_signs_in_on_its_own_origin(oauth, monkeypatch):
    import config

    preview = 'https://app-git-x.vercel.app'
    monkeypatch.setattr(config, 'ALLOWED_ORIGINS', (config.APP_URL, preview))
    client = oauth['client']
    client.base_url = 'https://testserver'  # Secure cookies on an HTTPS preview
    forwarded = {'x-forwarded-host': 'app-git-x.vercel.app', 'x-forwarded-proto': 'https'}
    response = client.get('/api/auth/login', headers=forwarded, follow_redirects=False)
    params = parse_qs(urlsplit(response.headers['location']).query)
    assert params['redirect_uri'] == [preview + '/api/auth/callback']
    oauth['nonce'] = params['nonce'][0]
    callback = client.get('/api/auth/callback', headers=forwarded, params={
        'code': 'test-code', 'state': params['state'][0],
    }, follow_redirects=False)
    assert callback.status_code == 303 and callback.headers['location'] == '/'
    assert parse_qs(oauth['requests'][0].content.decode())['redirect_uri'] == [preview + '/api/auth/callback']
    # Unknown hosts never steer the callback; the canonical origin is used instead.
    spoofed = client.get('/api/auth/login', headers={'x-forwarded-host': 'attacker.example'}, follow_redirects=False)
    assert parse_qs(urlsplit(spoofed.headers['location']).query)['redirect_uri'] == [config.APP_URL + '/api/auth/callback']
    # Mutations accept any of the deployment's origins and nothing else (422: past the gate).
    assert client.post('/api/notebooks', json={}, headers={'origin': preview}).status_code == 422
    assert client.post('/api/notebooks', json={}, headers={'origin': 'https://attacker.example'}).status_code == 403
