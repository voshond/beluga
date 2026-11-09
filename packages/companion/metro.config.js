// Metro for the companion: the app imports the shared contract straight from the repo
// (../../src/companion/protocol.ts), so the Mac and the phone can't disagree within one commit.
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const project = __dirname;
const repo = path.resolve(project, '../..');
// The shared contract (src/companion) and the shared, browser-safe models the phone draws with
// (src/shared: views, graphs, inline elements, as the Mac app reads them; src/ui: the screens'
// models, such as which agents you can pick; src/machines: only its browser-safe words.ts and
// look.ts, how a computer of yours is said and drawn).
const shared = [path.join(repo, 'src/companion'), path.join(repo, 'src/shared'), path.join(repo, 'src/ui'), path.join(repo, 'src/machines')];

const config = getDefaultConfig(project);

// Watch the shared code only (not the whole repo: the Mac app and the daemon are big).
config.watchFolders = shared;

// The repo's own node_modules must never leak in: everything the shared files import (zod)
// resolves from this package, so there is one copy of each library in the bundle.
config.resolver.nodeModulesPaths = [path.join(project, 'node_modules')];
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // The link worklet's bundle (npm run worklet:bundle): an empty module until it's built, so the
  // app (and its demo) runs from a fresh checkout. Never on the web (no Bare there).
  if (moduleName.endsWith('link.bundle.mjs')) {
    const file = path.resolve(path.dirname(context.originModulePath), moduleName);
    if (platform === 'web' || !fs.existsSync(file)) return { type: 'empty' };
  }
  const from = context.originModulePath;
  const outside = from && !from.startsWith(project + path.sep);
  // The repo's TypeScript imports its siblings as './x.js' (Node's ESM): that's './x.ts' here.
  if (outside && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const ts = path.resolve(path.dirname(from), moduleName.replace(/\.js$/, '.ts'));
    if (fs.existsSync(ts)) return { type: 'sourceFile', filePath: ts };
  }
  const ctx = outside && !moduleName.startsWith('.') && !path.isAbsolute(moduleName) ? { ...context, originModulePath: path.join(project, 'package.json') } : context;
  return upstream ? upstream(ctx, moduleName, platform) : ctx.resolveRequest(ctx, moduleName, platform);
};

module.exports = config;
