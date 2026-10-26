import { ChevronRight, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { JsonSchema } from "@/lib/api";
import { cn } from "@/lib/format";
import { Badge } from "./ui/misc";

function typeLabel(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.type === "array" && s.items) return `${typeLabel(s.items)}[]`;
  if (Array.isArray(s.anyOf)) return (s.anyOf as JsonSchema[]).map(typeLabel).join(" | ");
  return s.type ?? "any";
}

export function SchemaParams({ schema }: { schema: JsonSchema }) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  if (props.length === 0) return <p className="text-[12.5px] text-muted">This tool takes no arguments.</p>;
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full text-left text-[12.5px]">
        <tbody>
          {props.map(([name, p]) => (
            <tr key={name} className="border-b border-line last:border-0 align-top">
              <td className="w-1/3 bg-subtle/50 px-3 py-2">
                <code className="text-ink">{name}</code>
                {required.has(name) ? <span className="ml-1.5 text-2xs text-bad">required</span> : null}
              </td>
              <td className="px-3 py-2">
                <code className="text-[11.5px] break-all text-accent">{typeLabel(p)}</code>
                {p.default !== undefined && <span className="ml-2 text-[11.5px] text-faint">default {JSON.stringify(p.default)}</span>}
                {p.description && <div className="mt-0.5 text-muted">{p.description}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ToolRow({
  name,
  upstreamName,
  description,
  schema,
  readOnly,
  adminOnly,
  meta,
  control,
}: {
  name: string;
  upstreamName: string;
  description: string;
  schema: JsonSchema;
  readOnly: boolean | null;
  adminOnly: boolean;
  meta?: ReactNode;
  control?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <button onClick={() => setOpen((o) => !o)} className="mt-0.5 rounded p-0.5 text-faint hover:bg-hover hover:text-ink" aria-expanded={open} aria-label={`Show parameters for ${name}`}>
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="text-[13px] font-medium text-ink">{name}</code>
            {readOnly === true && <Badge>read</Badge>}
            {readOnly === false && <Badge tone="warn">write</Badge>}
            {adminOnly && (
              <Badge tone="accent">
                <ShieldCheck className="size-3" /> admins only
              </Badge>
            )}
            {meta}
          </div>
          <p className="mt-1 text-[13px] text-muted">{description || <span className="italic">No description</span>}</p>
          {open && (
            <div className="mt-3 space-y-2">
              <div className="text-[12px] text-faint">
                Upstream name <code className="text-ink-2">{upstreamName}</code>
              </div>
              <SchemaParams schema={schema} />
            </div>
          )}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
    </li>
  );
}
