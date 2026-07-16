// backend/server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables from .env
dotenv.config();

// Import routers
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const restaurantsRouter = require('./routes/restaurants');
const usersRouter = require('./routes/users');
const paymentRouter = require('./routes/payment');
const uploadRouter = require('./routes/upload');
const financeRouter = require('./routes/finance');
const settingsRouter = require('./routes/settings');

const app = express();

/* ------------------ SECURITY HEADERS ------------------ */
try {
  const helmet = require('helmet');
  app.use(helmet());
} catch {
  // helmet not installed; run: npm install helmet
}

/* ------------------ CORS SETUP ------------------ */
// Allow all origins (mobile app, Expo, web)
app.use(
  cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Handle preflight
app.options('*', cors());

/* ------------------ MIDDLEWARE ------------------ */
app.use(express.json({ limit: '100kb' }));

/* ------------------ BASIC TEST ROUTES ------------------ */

// For quick "is backend alive?" test in browser
app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

// Health check route for testing from phone: /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

/* ------------------ API ROUTES ------------------ */

app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/restaurants', restaurantsRouter);
app.use('/api/users', usersRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/finance', financeRouter);
app.use('/api/settings', settingsRouter);

/* ------------------ HTTP SERVER + SOCKET.IO ------------------ */

const PORT = process.env.PORT || 4040; // Make sure this matches your API_BASE_URL
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Socket events
io.on('connection', (socket) => {
  console.log('🔌 Socket connected', socket.id);

  socket.on('joinRestaurant', (restaurantId) => {
    if (!restaurantId) return;
    socket.join(`restaurant:${restaurantId}`);
    console.log(`✅ Socket ${socket.id} joined room restaurant:${restaurantId}`);
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected', socket.id);
  });
});

// Make Socket.IO available in routes (req.app.get('io'))
app.set('io', io);

/* ------------------ DATABASE SETUP ------------------ */

const MONGO_URI = process.env.MONGO_URI;

// Connect to MongoDB, then start the server
mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log('✅ MongoDB connected');
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('⚠️ MongoDB connection failed, exiting:', err.message || err);
    process.exit(1);
  });

module.exports = app;
