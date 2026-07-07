const http = require("http");

http.get("http://127.0.0.1:4000/health", (res) => {
  let body = "";
  res.on("data", (c) => (body += c));
  res.on("end", () => {
    const json = JSON.parse(body);
    if (res.statusCode === 200 && json.status === "healthy") {
      console.log("health check test passed");
      process.exit(0);
    }
    console.error("health check test failed:", body);
    process.exit(1);
  });
}).on("error", (e) => {
  console.error("health check test error:", e.message);
  process.exit(1);
});
