// Imported first by main.tsx. Zod 4 decides per schema, when the schema is *constructed*, whether
// to JIT-compile it with `new Function`. The dashboard's CSP forbids eval, so turn the JIT off
// before any module builds a schema, instead of loosening the policy.
import { z } from "zod";

z.config({ jitless: true });
