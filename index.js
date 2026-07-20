// This file only exists because package.json's "main" field points here.
// The real server implementation lives entirely in server.js - this used to
// be an outdated, half-broken duplicate of it (missing the metadata/cards_list
// support the frontend relies on, a stray duplicated setInterval block, etc.),
// which is exactly the kind of drift that's easy to end up debugging by
// accident. To avoid that happening again, this file just loads server.js
// so there is a single source of truth for the backend.
//
// If your Render (or other host) start command runs `node index.js` /
// `npm start`, this will still work correctly. If it explicitly runs
// `node server.js`, this file isn't even used, but it's kept in sync here
// just in case.
require('./server.js');
