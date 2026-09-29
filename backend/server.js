const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/puzzle', require('./routes/admin')); // /progress lives in admin.js
app.use('/api/ai', require('./routes/admin'));      // /chat and /verify live in admin.js
app.use('/api/spectator', require('./routes/spectator'));
app.use('/api/timer', require('./routes/timer'));

// Serve frontend static files (location.html is the entry point)
app.use(express.static(path.join(__dirname, '../frontend'), { index: 'location.html' }));

// Fallback: serve location.html for all non-API routes
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/location.html'));
});

// Auto-seed on startup
require('./db/seed');

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
