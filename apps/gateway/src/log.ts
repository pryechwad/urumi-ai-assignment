type Level = "debug" | "info" | "warn" | "error";

export function createLogger(service = "gateway", silent = false) {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (silent) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...fields });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => process.env.LOG_LEVEL === "debug" && write("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
  };
}

export type Logger = ReturnType<typeof createLogger>;
