/**
 * aacyn API Control Plane — Production Entrypoint
 *
 * Imports the Elysia app instance and binds it to a port.
 * The app is defined in server.ts so tests can import it
 * without triggering .listen().
 */

import { app } from "./server";
import { createLogger } from "./lib/logger";
const log = createLogger("index");



const PORT = Number(process.env.PORT ?? 3001);

app.listen(PORT);

log.info(`🔭 aacyn API running at http://localhost:${PORT}`);

export type App = typeof app;
