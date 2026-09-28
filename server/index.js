import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import apiRouter from './routes/api.js';
import { startWeatherPolling } from './modules/weather.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middlewares
app.use(
  cors({
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from /public
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// API Routes
app.use('/api', apiRouter);

// Fallback for SPA routing if needed
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Central Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message,
  });
});

// Start server only when executed directly (not when imported in tests)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('server\\index.js') || 
  process.argv[1].endsWith('server/index.js') ||
  process.argv[1].endsWith('server')
);

if (isMain && process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[Landslide Dashboard Server] Running on http://localhost:${config.port}`);
    console.log(`[Landslide Dashboard Server] ESP32 POST Endpoint: http://<SERVER_IP>:${config.port}/api/sensor-data`);
    // Start background weather polling worker
    startWeatherPolling();
    console.log(`[Landslide Dashboard Server] Weather polling started (interval: ${config.weather?.pollMinutes || 15}m)`);
  });
}

export default app;
