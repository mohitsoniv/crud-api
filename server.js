const express = require("express");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    service: "crud-api",
    status: "running",
    endpoints: {
      health: "/health",
      items: "/items"
    }
  });
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "healthy", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", db: "disconnected" });
  }
});

app.get("/items", async (req, res) => {
  const items = await prisma.item.findMany();
  res.json(items);
});

app.post("/items", async (req, res) => {
  const { name, quantity } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const item = await prisma.item.create({ data: { name, quantity: quantity ?? 0 } });
  res.status(201).json(item);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`crud-api listening on ${PORT}`));
