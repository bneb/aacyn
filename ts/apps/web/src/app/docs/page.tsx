import styles from "./docs.module.css";
import Link from "next/link";
import type { Metadata } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Logo } from "@/components/logo";
import { MermaidDiagram } from "./mermaid";
import { Header } from "@/components/header";

export const metadata: Metadata = {
    title: "Docs — aacyn",
    description:
        "Technical documentation for the aacyn observability appliance. Quickstart, API reference, configuration, and operations.",
};

/* ─── Read markdown files at build time ────────────────────────────── */

const DOCS_ROOT = join(process.cwd(), "src", "data");

function readDoc(filename: string): string {
    try {
        return readFileSync(join(DOCS_ROOT, filename), "utf-8");
    } catch {
        return `*File not found: ${filename}*`;
    }
}

const SECTIONS = [
    {
        id: "quickstart", title: "Quickstart", tag: "Start here", file: "QUICKSTART.md",
        desc: "Deploy self-hosted observability in 5 minutes."
    },
    {
        id: "api", title: "API Reference", tag: "Reference", file: "api-reference.md",
        desc: "Every endpoint, field, and status code."
    },
    {
        id: "config", title: "Configuration", tag: "Reference", file: "configuration.md",
        desc: "All environment variables with defaults."
    },
    {
        id: "binary", title: "Binary Protocol", tag: "Advanced", file: "binary-protocol.md",
        desc: "The 5M evt/sec FlatBuffer wire format."
    },
    {
        id: "ebpf", title: "eBPF Probes", tag: "Advanced", file: "ebpf.md",
        desc: "Zero-instrumentation kernel telemetry."
    },
    {
        id: "contact", title: "Contact & Support", tag: "Support", file: "contact.md",
        desc: "Get help, report issues, and self-service troubleshooting."
    },
];

/* ─── Custom renderers for markdown elements ───────────────────────── */

const mdComponents = {
    h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h1 className={styles.md__h1} {...props}>{children}</h1>
    ),
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h2 className={styles.md__h2} {...props}>{children}</h2>
    ),
    h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3 className={styles.md__h3} {...props}>{children}</h3>
    ),
    p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
        <p className={styles.md__p} {...props}>{children}</p>
    ),
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
        // Detect mermaid code blocks: <pre><code className="language-mermaid">
        const child = children as React.ReactElement<{ className?: string; children?: string }>;
        if (child?.props?.className === "language-mermaid") {
            const chart = String(child.props.children || "").trim();
            return <MermaidDiagram chart={chart} />;
        }
        return <pre className={styles.md__pre} {...props}>{children}</pre>;
    },
    code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
        // Mermaid handled by pre — skip here
        if (className === "language-mermaid") {
            return <code {...props}>{children}</code>;
        }
        const isInline = !className;
        return isInline
            ? <code className={styles.md__code_inline} {...props}>{children}</code>
            : <code className={styles.md__code_block} {...props}>{children}</code>;
    },
    table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
        <div className={styles.md__table_wrap}>
            <table className={styles.md__table} {...props}>{children}</table>
        </div>
    ),
    blockquote: ({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
        <blockquote className={styles.md__blockquote} {...props}>{children}</blockquote>
    ),
    ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
        <ul className={styles.md__ul} {...props}>{children}</ul>
    ),
    ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
        <ol className={styles.md__ol} {...props}>{children}</ol>
    ),
    hr: () => <hr className={styles.md__hr} />,
    strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
        <strong className={styles.md__strong} {...props}>{children}</strong>
    ),
};

export default function DocsPage() {
    return (
        <div className={styles.docs}>
            <Header />

            {/* ── Hero ────────────────────────────────────────────────────── */}
            <header className={styles.hero}>
                <h1 className={styles.hero__title}>Documentation</h1>
                <p className={styles.hero__subtitle}>
                    Everything you need to deploy, integrate, and operate the aacyn
                    telemetry appliance, thus always in sync.
                </p>
            </header>

            {/* ── Doc Index ───────────────────────────────────────────────── */}
            <section className={styles.index}>
                <div className={styles.index__grid}>
                    {SECTIONS.map((sec) => (
                        <a key={sec.id} href={`#${sec.id}`} className={styles.index__card}>
                            <span className={styles.index__tag}>{sec.tag}</span>
                            <h3 className={styles.index__title}>{sec.title}</h3>
                            <p className={styles.index__desc}>{sec.desc}</p>
                        </a>
                    ))}
                </div>
            </section>

            {/* ── Rendered Markdown Sections ──────────────────────────────── */}
            {SECTIONS.map((sec) => (
                <section key={sec.id} id={sec.id} className={styles.section}>
                    <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={mdComponents}
                    >
                        {readDoc(sec.file)}
                    </Markdown>
                </section>
            ))}

            {/* ── Footer ──────────────────────────────────────────────────── */}
            <footer className={styles.footer}>
                <span className={styles.footer__brand}>aacyn</span>
                <div className={styles.footer__links}>
                    <Link href="/">Home</Link>
                    <Link href="/benchmarks">Benchmarks</Link>
                </div>
            </footer>
        </div>
    );
}
