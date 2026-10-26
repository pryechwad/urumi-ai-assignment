import { useMutation } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronRight, CircleAlert, MessageSquare, RotateCcw, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageHeader, Spinner } from "@/components/ui/misc";
import { api, type ChatResponse, type ChatStep } from "@/lib/api";
import { useAuth, useMeta } from "@/lib/auth";
import { cn, duration } from "@/lib/format";

interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: ChatStep[];
  error?: boolean;
}

const STORAGE_KEY = "urumi.chat.v1";
const SUGGESTIONS = [
  "What orders came in today?",
  'Create a product called "Monsoon Rain Jacket" priced at 2499',
  "Which items are low on warehouse stock? Are there open support tickets about them?",
  "Show me the three newest support tickets",
];

function loadTurns(): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Tiny, safe Markdown subset: paragraphs, bullet lists, tables, **bold** and `code`. No HTML injection. */
function RichText({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="rounded bg-subtle px-1 py-px text-[12.5px]">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="my-1.5 list-disc space-y-0.5 pl-5">
          {list.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  let table: string[][] = [];
  const flushTable = () => {
    if (!table.length) return;
    const [head, ...rows] = table;
    blocks.push(
      <div key={blocks.length} className="my-2 overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-subtle/60">
            <tr>
              {head.map((c, i) => (
                <th key={i} className="px-2.5 py-1.5 font-medium whitespace-nowrap text-muted">
                  {inline(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className="px-2.5 py-1.5 align-top">
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = [];
  };
  for (const line of text.split("\n")) {
    // Markdown table rows: | a | b |. The |---|---| separator row is skipped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.push(cells);
      continue;
    }
    flushTable();
    const m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (m) list.push(m[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length} className="my-1.5 first:mt-0 last:mb-0">{inline(line.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  flushTable();
  return <div className="text-[13.5px] leading-relaxed text-ink">{blocks}</div>;
}

function StepRow({ step }: { step: ChatStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-line bg-surface">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left" aria-expanded={open}>
        <span className={cn("flex size-4 items-center justify-center rounded-full", step.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
          {step.ok ? <Check className="size-2.5" strokeWidth={3} /> : <X className="size-2.5" strokeWidth={3} />}
        </span>
        <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{step.tool}</code>
        <Badge className="hidden sm:inline-flex">{step.server}</Badge>
        <span className="text-[11.5px] text-faint tabular">{duration(step.durationMs)}</span>
        <ChevronRight className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2 text-[12px]">
          <div>
            <div className="mb-1 text-2xs font-medium tracking-wide text-faint uppercase">Arguments</div>
            <pre className="overflow-x-auto rounded bg-subtle p-2 text-[11.5px] text-ink-2">{JSON.stringify(step.args, null, 2)}</pre>
          </div>
          <div>
            <div className="mb-1 text-2xs font-medium tracking-wide text-faint uppercase">{step.ok ? "Result" : "Error"}</div>
            <pre className={cn("max-h-60 overflow-auto rounded p-2 text-[11.5px] whitespace-pre-wrap", step.ok ? "bg-subtle text-ink-2" : "bg-bad-soft text-bad")}>
              {step.preview}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

export function ChatPage() {
  const { user } = useAuth();
  const meta = useMeta();
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-30)));
    } catch {
      /* storage unavailable: history just won't survive reloads */
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      api.post<ChatResponse>("/chat", {
        // Only plain text goes back to the server; tool results are never accepted from the browser.
        messages: history.filter((t) => !t.error).slice(-20).map((t) => ({ role: t.role, content: t.content })),
      }),
    onSuccess: (res) => setTurns((t) => [...t, { role: "assistant", content: res.reply, steps: res.steps }]),
    onError: (err) => setTurns((t) => [...t, { role: "assistant", content: (err as Error).message, error: true }]),
  });

  const submit = (text: string) => {
    const content = text.trim();
    if (!content || send.isPending) return;
    const next = [...turns, { role: "user" as const, content }];
    setTurns(next);
    setInput("");
    send.mutate(next);
  };

  const enabled = meta.data?.chat.enabled;

  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col lg:min-h-[calc(100dvh-4.5rem)]">
      <PageHeader
        title="Chat"
        description={<>Uses the gateway's tools as <span className="text-ink">{user?.email}</span>, with your permissions. Calls are audited under your name.</>}
        actions={
          <>
            {meta.data?.chat.model && <span className="text-[12px] text-faint">{meta.data.chat.model}</span>}
            {turns.length > 0 && (
              <Button size="sm" onClick={() => setTurns([])} disabled={send.isPending}>
                <RotateCcw /> New conversation
              </Button>
            )}
          </>
        }
      />

      {meta.data && !enabled ? (
        <Card className="p-5">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="text-[13px]">
              <p className="font-medium text-ink">The chat agent is not configured</p>
              <p className="mt-1 text-muted">
                An operator needs to set <code className="text-ink">LLM_API_KEY</code> (and optionally <code className="text-ink">LLM_PROVIDER</code>, <code className="text-ink">LLM_MODEL</code>) in the gateway's
                Kubernetes Secret. The MCP endpoint works without it.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {turns.length === 0 ? (
              <div className="mx-auto flex max-w-lg flex-col items-center py-8 text-center">
                <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
                  <MessageSquare className="size-4.5" />
                </div>
                <p className="text-sm font-medium text-ink">Ask about orders, products, stock or tickets</p>
                <p className="mt-1 text-[13px] text-muted">The agent picks tools from every enabled server and shows each call it makes.</p>
                <div className="mt-5 grid w-full gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => submit(s)} className="rounded-md border border-line bg-surface px-3 py-2 text-left text-[13px] text-ink-2 hover:border-line-strong hover:text-ink">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-6">
                {turns.map((t, i) =>
                  t.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-[14px] whitespace-pre-wrap text-white shadow-md shadow-blue-600/20">{t.content}</div>
                    </div>
                  ) : (
                    <div key={i} className="space-y-2.5">
                      {t.steps && t.steps.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[12px] text-muted">
                            Called {t.steps.length} tool{t.steps.length === 1 ? "" : "s"} through the gateway
                          </div>
                          <ul className="space-y-1.5">
                            {t.steps.map((s, j) => (
                              <StepRow key={j} step={s} />
                            ))}
                          </ul>
                        </div>
                      )}
                      {t.error ? (
                        <div className="flex gap-2 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-bad">
                          <CircleAlert className="mt-0.5 size-4 shrink-0" /> {t.content}
                        </div>
                      ) : (
                        <RichText text={t.content} />
                      )}
                    </div>
                  ),
                )}
                {send.isPending && (
                  <div className="flex items-center gap-2 text-[13px] text-muted">
                    <Spinner className="size-3.5" /> Working: the agent may call several tools…
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
          <form
            className="border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border border-line-strong bg-surface p-1.5 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                rows={1}
                maxLength={8000}
                placeholder="Ask a question…"
                aria-label="Message"
                className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] outline-none placeholder:text-faint"
              />
              <Button type="submit" variant="primary" size="icon" disabled={!input.trim()} loading={send.isPending} aria-label="Send">
                {!send.isPending && <ArrowUp />}
              </Button>
            </div>
            <p className="mx-auto mt-1.5 max-w-3xl text-[11.5px] text-faint">Enter to send · Shift+Enter for a new line</p>
          </form>
        </Card>
      )}
    </div>
  );
}
