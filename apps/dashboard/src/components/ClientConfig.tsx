import { useState } from "react";
import { cn } from "@/lib/format";
import { CopyButton } from "./ui/misc";

const CLIENTS = ["Claude Code", "Cursor", "MCP Inspector"] as const;

/** Copy-paste configuration for common MCP clients. Only the gateway URL and the user's key. */
export function ClientConfig({ url, apiKey }: { url: string; apiKey?: string }) {
  const [client, setClient] = useState<(typeof CLIENTS)[number]>("Claude Code");
  const key = apiKey ?? "<your API key>";

  const snippet =
    client === "Claude Code"
      ? `claude mcp add --transport http urumi ${url} \\\n  --header "Authorization: Bearer ${key}"`
      : client === "Cursor"
        ? JSON.stringify({ mcpServers: { urumi: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)
        : `npx @modelcontextprotocol/inspector\n\n# In the Inspector UI:\n#   Transport type:  Streamable HTTP\n#   URL:             ${url}\n#   Authentication:  header "Authorization" = "Bearer ${key}"\n# then Connect → Tools → List Tools`;

  const hint =
    client === "Claude Code"
      ? "Run in a terminal, then /mcp inside Claude Code to see the tools."
      : client === "Cursor"
        ? "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project)."
        : "Opens a local web UI for exploring and calling tools.";

  return (
    <div>
      <div className="mb-2 flex gap-1 border-b border-line">
        {CLIENTS.map((c) => (
          <button
            key={c}
            onClick={() => setClient(c)}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-1.5 text-[13px] transition-colors",
              client === c ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[12px] text-muted">{hint}</p>
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-line bg-subtle p-3 pr-20 text-[12px] leading-relaxed text-ink">{snippet}</pre>
        <CopyButton value={snippet} className="absolute top-2 right-2" />
      </div>
    </div>
  );
}
