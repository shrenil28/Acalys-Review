const service = process.env["ACALYS_SERVICE"];

const entrypoints = {
  api: "../apps/api/dist/main.js",
  "review-worker": "../apps/review-worker/dist/main.js",
  "webhook-gateway": "../apps/webhook-gateway/dist/main.js",
  migrate: "../apps/api/dist/migrate.js",
  bootstrap: "../apps/api/dist/bootstrap.js",
};

const entrypoint = entrypoints[service];
if (entrypoint === undefined) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "service.invalid_configuration",
      message:
        "ACALYS_SERVICE must be api, review-worker, webhook-gateway, migrate, or bootstrap",
    }),
  );
  process.exitCode = 1;
} else {
  await import(entrypoint);
}
