import { Fragment, type ReactNode } from "react";
import { BookOpen, Github } from "lucide-react";

const source = "https://github.com/vercel-labs/notebook-factory";
const components: { name: string; url: string; text: ReactNode; links?: { name: string; url: string }[] }[] = [
  { name: "Neon", url: "https://neon.com/docs/introduction", text: "Postgres stores users, notebook documents and outputs, published revisions, chat history, and editor sessions. It also powers full-text search across notebook titles and content." },
  { name: "Vercel CDN + Vite", url: "https://vercel.com/docs/cdn", links: [{ name: "Vercel CDN", url: "https://vercel.com/docs/cdn" }, { name: "Vite", url: "https://vite.dev/" }], text: "Vite builds the React frontend into static assets; Vercel CDN serves them." },
  { name: "Vercel + FastAPI", url: "https://vercel.com/docs/frameworks/backend/fastapi", links: [{ name: "Vercel", url: "https://vercel.com/docs/frameworks/backend/fastapi" }, { name: "FastAPI", url: "https://fastapi.tiangolo.com/" }], text: "Runs FastAPI on Vercel Fluid Serverless platform." },
  { name: "Vercel Services", url: "https://vercel.com/docs/services", text: "Deploys the FastAPI backend and Vite frontend together in one project, with shared routing under one domain." },
  { name: "Vercel Blob", url: "https://vercel.com/docs/vercel-blob", text: "Stores rendered notebook HTML and prepared font assets. Published notebooks can be read without starting a kernel." },
  { name: "Vercel AI Gateway", url: "https://vercel.com/docs/ai-gateway", text: "Routes model requests from the backend, authenticated with the deployment's Vercel identity." },
  { name: "Vercel Python AI SDK", url: "https://ai-python.dev/", text: "Runs the agent's model and tool loop, streaming responses to the browser. Tools read, edit, and execute notebook cells." },
  { name: "Vercel AI SDK UI", url: "https://ai-sdk.dev/docs/ai-sdk-ui/overview", text: "The Python AI SDK is compatible with AI SDK UI. React useChat handles its streamed messages, tool progress, and tool results in the chat panel." },
  { name: "Vercel Sandbox", url: "https://vercel.com/docs/vercel-sandbox", text: <>Runs JupyterLab in one isolated VM per user, with a separate kernel per notebook. The <a href="https://vercel.com/docs/sandbox/python-sdk-reference" target="_blank" rel="noopener noreferrer">▲ Python Sandbox SDK</a> manages VM lifecycle, commands, and workspace drives.</> },
  { name: "Jupyter Notebooks", url: "https://jupyter.org/", text: "Standard .ipynb files contain code, Markdown, and execution outputs. JupyterLab provides the embedded editor; nbconvert renders published HTML." },
  { name: "lat.md", url: "https://lat.md", text: "Repository documentation links architecture, design decisions, and test specifications to implementation symbols." },
];

export function About({ onBack }: { onBack: () => void }) {
  return <article className="about-page" aria-labelledby="about-title">
    <div className="about-content">
      <nav className="about-nav" aria-label="About page">
        <a href="/" onClick={event => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); onBack(); } }}>← Notebooks</a>
      </nav>
      <h1 id="about-title">How it works</h1>
      <p className="about-summary">React frontend, Python API, Jupyter execution in ▲ Sandbox. The agent edits notebook cells; documents are saved to Postgres and rendered HTML is published to ▲ Blob.</p>
      <a className="about-source button" href={source} target="_blank" rel="noopener noreferrer"><Github size={16} aria-hidden="true" />View source on GitHub</a>
      <a className="about-source button" href="/lat/"><BookOpen size={16} aria-hidden="true" />See lat.md project architecture</a>
      <dl className="about-stack" aria-label="Technology stack">
        {components.map(({ name, url, text, links }) => <div className="about-component" key={name}>
          <dt>{(links ?? [{ name, url }]).map((link, index) => <Fragment key={link.name}>
            {index > 0 && " + "}<a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={link.name}>{link.name.replaceAll("Vercel", "▲")}</a>
          </Fragment>)}</dt>
          <dd>{typeof text === "string" ? text.replaceAll("Vercel", "▲") : text}</dd>
        </div>)}
      </dl>
    </div>
  </article>;
}
