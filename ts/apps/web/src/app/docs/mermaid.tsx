"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
        darkMode: true,
        primaryColor: "#6366f1",
        primaryTextColor: "#f0f0f5",
        primaryBorderColor: "rgba(255,255,255,0.12)",
        lineColor: "#55556a",
        secondaryColor: "#1a1a28",
        tertiaryColor: "#12121a",
        background: "#0a0a0f",
        mainBkg: "#1a1a28",
        nodeBorder: "rgba(255,255,255,0.12)",
        clusterBkg: "#12121a",
        clusterBorder: "rgba(255,255,255,0.06)",
        titleColor: "#f0f0f5",
        edgeLabelBackground: "#12121a",
        fontSize: "14px",
    },
});

let mermaidCounter = 0;

export function MermaidDiagram({ chart }: { chart: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState("");
    const [error, setError] = useState(false);

    useEffect(() => {
        const id = `mermaid-${++mermaidCounter}`;
        mermaid
            .render(id, chart)
            .then((result) => setSvg(result.svg))
            .catch(() => setError(true));
    }, [chart]);

    if (error) {
        return (
            <pre style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.8rem",
                color: "var(--color-text-secondary)",
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-lg)",
                overflow: "auto",
            }}>
                {chart}
            </pre>
        );
    }

    if (!svg) return null;

    return (
        <div
            ref={ref}
            dangerouslySetInnerHTML={{ __html: svg }}
            style={{
                margin: "var(--space-md) 0",
                display: "flex",
                justifyContent: "center",
                overflow: "auto",
            }}
        />
    );
}
