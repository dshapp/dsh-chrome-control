//#region src/daemon.ts
/**
* Addresses of the standalone chrome-daemon shared by the server plugin and the
* web-search provider.
* @module dsh-chrome/daemon
*/
/** The daemon's fixed port. The extension's `dsh_chrome_url` default matches. */
const DAEMON_PORT = 37086;
/** The daemon's MCP endpoint URL. */
const DAEMON_MCP_URL = `http://127.0.0.1:${DAEMON_PORT}/chrome/mcp`;
//#endregion
export { DAEMON_PORT as n, DAEMON_MCP_URL as t };
