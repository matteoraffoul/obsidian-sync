import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

const config = loadConfig();
const app = createApp(config);

if (app.users.list().length === 0) {
  app.server.log.warn('No users yet. Create one with: npm run user -w server -- add <username> --admin');
}

await app.server.listen({ host: config.host, port: config.port });
app.server.log.info(`Team Sync server ${VERSION}, data in ${config.dataDir}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
