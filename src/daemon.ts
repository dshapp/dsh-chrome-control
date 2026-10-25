/**
 * Addresses of the standalone chrome-daemon shared by the server plugin and the
 * web-search provider.
 * @module dsh-chrome/daemon
 */

/** The daemon's fixed port. The extension's `dsh_chrome_url` default matches. */
export const DAEMON_PORT = 37086

/** The daemon's MCP Streamable HTTP endpoint path. */
export const MCP_PATH = '/chrome/mcp'

/** The daemon's MCP endpoint URL. */
export const DAEMON_MCP_URL = `http://127.0.0.1:${DAEMON_PORT}${MCP_PATH}`
