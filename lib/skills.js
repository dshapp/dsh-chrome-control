import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as SkillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
//#region src/skills.ts
/**
* dsh-chrome companion plugin: mounts a dsh-skill-filesystem provider scoped to
* this package's own bundled `skills/` directory, so the Chrome skill is
* discovered without a manual copy step. Resolves its own installed location
* through `createRequire`, the technique DeepSeek Harness's own bundles use to
* find their installed assets.
*
* @module dsh-chrome/skills
*/
/** Stable Cordis plugin name. */
const name = "chrome-skills";
/** Provider name registered on `ctx.skills`. */
const SKILL_PROVIDER_NAME = "chrome";
/**
* Resolve this package's bundled `skills/` directory from its own installed
* location, independent of the caller's working directory.
* @returns the absolute path to the bundled skills directory.
*/
function resolveBundledSkillsDir() {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve("../package.json")), "skills");
}
/**
* Mount the bundled skill directory as an isolated provider, contributing only
* this package's own skill and no default roots.
* @param ctx - plugin context; skill-filesystem injects `skills` from it.
*/
function apply(ctx) {
	ctx.plugin(SkillFilesystem, {
		providerName: SKILL_PROVIDER_NAME,
		includeDefaultRoots: false,
		customSkillDirs: [resolveBundledSkillsDir()]
	});
}
//#endregion
export { SKILL_PROVIDER_NAME, apply, name, resolveBundledSkillsDir };
