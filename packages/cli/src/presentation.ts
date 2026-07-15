interface ServerReadyDetails {
  adminUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  databasePath: string;
  discoveryUrl: string;
  doctorCommand?: string;
  testCommand?: string;
  profile?: string;
}

interface FormatOptions {
  color?: boolean;
}

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m"
};

function shouldUseColor(): boolean {
  return Boolean(
    process.stdout.isTTY &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb"
  );
}

function paint(value: string, code: keyof typeof ansi, enabled: boolean): string {
  return enabled ? `${ansi[code]}${value}${ansi.reset}` : value;
}

function row(label: string, value: string, color: boolean): string {
  return `  ${paint(label.padEnd(10), "dim", color)} ${value}`;
}

export function formatServerReady(details: ServerReadyDetails, options: FormatOptions = {}): string {
  const color = options.color ?? shouldUseColor();
  const divider = paint("=".repeat(62), "cyan", color);
  const title = `${paint("Loyalty Interchange", "bold", color)} ${paint("local sandbox", "dim", color)}`;
  const ready = paint("[ready]", "green", color);
  const next = paint("Next steps", "bold", color);
  const key = paint(details.apiKey, "yellow", color);
  const doctorCommand = details.doctorCommand ?? "lip doctor";
  const testCommand = details.testCommand ?? "lip test";

  return [
    "",
    divider,
    title,
    `${ready} Reference API and Admin dashboard are running.`,
    "",
    row("Admin", details.adminUrl, color),
    row("API", `${details.apiBaseUrl}/lip/v1`, color),
    row("Health", `${details.apiBaseUrl}/health`, color),
    row("Discovery", details.discoveryUrl, color),
    row("Profile", details.profile ?? "foodservice/1.0", color),
    row("Storage", details.databasePath, color),
    row("Key", key, color),
    "",
    "Use the Admin/API key for both dashboard sign-in and Bearer API requests.",
    "",
    next,
    `  1. Open Admin: ${details.adminUrl}`,
    `  2. Run diagnostics: ${doctorCommand}`,
    `  3. Run baseline conformance: ${testCommand}`,
    "",
    "Bearer example",
    `  curl ${details.apiBaseUrl}/lip/v1/capabilities \\`,
    `    -H 'Authorization: Bearer ${details.apiKey}'`,
    "",
    paint("Press Ctrl+C to stop the local server.", "dim", color),
    divider,
    ""
  ].join("\n");
}
