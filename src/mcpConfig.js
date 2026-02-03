import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function normalizeBrowserUrl(browserUrl) {
  const url = String(browserUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `http://${url}`;
}

function resolveLocalMcpBinary() {
  const name =
    process.platform === 'win32' ? 'chrome-devtools-mcp.cmd' : 'chrome-devtools-mcp';
  const localPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', name);
  try {
    fsSync.accessSync(localPath, fsSync.constants.X_OK);
    return localPath;
  } catch {
    return '';
  }
}

function resolveNpxCommand() {
  if (process.env.AUDIT_NPX_PATH) return String(process.env.AUDIT_NPX_PATH);
  if (process.platform === 'win32') return 'npx.cmd';

  const candidates = [
    // Homebrew default locations (covers some sanitized PATH cases).
    '/usr/local/bin/npx',
    '/opt/homebrew/bin/npx',
    'npx'
  ];

  for (const candidate of candidates) {
    try {
      if (candidate === 'npx') return candidate;
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {}
  }

  return 'npx';
}

function resolveMcpCommand() {
  const overridden = String(process.env.AUDIT_MCP_COMMAND || '').trim();
  if (overridden) return { command: overridden, baseArgs: [] };

  const local = resolveLocalMcpBinary();
  if (local) return { command: local, baseArgs: [] };

  // Upstream recommends using `npx -y` to avoid interactive install prompts.
  // This is critical for non-interactive `codex exec` runs where there is no TTY.
  return { command: resolveNpxCommand(), baseArgs: ['-y', 'chrome-devtools-mcp@latest'] };
}

export function buildMcpArgs({ browserUrl, autoConnect, channel, ocr, utils } = {}) {
  if (process.env.CODEX_MCP_MODE === 'none') {
    return ['-c', 'mcp_servers={}'];
  }

  const url = normalizeBrowserUrl(browserUrl || process.env.AUDIT_MCP_BROWSER_URL);
  const resolvedAutoConnect =
    url ? false : typeof autoConnect === 'boolean' ? autoConnect : true;
  const resolvedChannel = String(channel || process.env.AUDIT_MCP_CHANNEL || '').trim();

  // We still set npm_config_yes=true in buildCodexEnv(), but `npx -y` is the most reliable
  // way to suppress install prompts across npm versions.
  const { command, baseArgs } = resolveMcpCommand();
  const args = [...baseArgs];
  if (url) {
    args.push(`--browser-url=${url}`);
  } else if (resolvedAutoConnect) {
    args.push('--autoConnect');
    if (resolvedChannel) args.push(`--channel=${resolvedChannel}`);
  }

  // Codex `-c` values are parsed as TOML. Use dotted paths so values are valid TOML scalars/arrays.
  const configs = [
    '-c',
    'mcp_servers={}',
    '-c',
    `mcp_servers.chrome-devtools.command=${JSON.stringify(command)}`,
    '-c',
    `mcp_servers.chrome-devtools.args=${JSON.stringify(args)}`,
    '-c',
    'mcp_servers.chrome-devtools.startup_timeout_sec=30'
  ];

  if (ocr) {
    const ocrCommand = String(process.env.AUDIT_OCR_COMMAND || process.execPath || 'node');
    const ocrScript = String(
      process.env.AUDIT_OCR_SCRIPT || path.join(PROJECT_ROOT, 'src', 'mcpOcrServer.js')
    );
    const ocrArgs = [ocrScript];
    configs.push(
      '-c',
      `mcp_servers.rgaa-ocr.command=${JSON.stringify(ocrCommand)}`,
      '-c',
      `mcp_servers.rgaa-ocr.args=${JSON.stringify(ocrArgs)}`,
      '-c',
      'mcp_servers.rgaa-ocr.startup_timeout_sec=30'
    );
  }

  if (utils) {
    const utilsCommand = String(process.env.AUDIT_UTILS_COMMAND || process.execPath || 'node');
    const utilsScript = String(
      process.env.AUDIT_UTILS_SCRIPT || path.join(PROJECT_ROOT, 'src', 'mcpUtilsServer.js')
    );
    const utilsArgs = [utilsScript];
    configs.push(
      '-c',
      `mcp_servers.rgaa-utils.command=${JSON.stringify(utilsCommand)}`,
      '-c',
      `mcp_servers.rgaa-utils.args=${JSON.stringify(utilsArgs)}`,
      '-c',
      'mcp_servers.rgaa-utils.startup_timeout_sec=30'
    );
  }

  return configs;
}

export function looksLikeMcpConnectError(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    text.includes('econnrefused') ||
    text.includes('connection refused') ||
    (text.includes('connect') && text.includes('9222')) ||
    text.includes('websocket') ||
    text.includes('ws://') ||
    (text.includes('devtools') && text.includes('connect'))
  );
}

export function looksLikeMcpInstallOrNetworkError(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    (text.includes('chrome-devtools-mcp') &&
      (text.includes('registry.npmjs.org') ||
        text.includes('npm error network') ||
        text.includes('enotfound') ||
        text.includes('etimedout') ||
        text.includes('eai_again') ||
        text.includes('self signed certificate') ||
        text.includes('unable to get local issuer certificate'))) ||
    (text.includes('npx') && text.includes('network')) ||
    (text.includes('rgaa-ocr') &&
      (text.includes('spawn') || text.includes('error') || text.includes('failed'))) ||
    (text.includes('rgaa-utils') &&
      (text.includes('spawn') || text.includes('error') || text.includes('failed'))) ||
    text.includes('mcp startup') ||
    text.includes('mcp server') && text.includes('failed')
  );
}
