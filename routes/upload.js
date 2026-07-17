const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { requireVendor } = require('../middleware/auth');

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// This endpoint used to be open to the internet with no auth, no type check and
// no size limit. That is someone else's free file host billed to us, a way to
// serve arbitrary content from our Cloudinary account, and — because multer
// buffers into memory — a way to exhaust the server's RAM with one large POST.
//
// Only vendors and admins upload here (menu photos, outlet banners), so it is
// gated on a vendor session, capped, and restricted to real image types.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — ample for a menu photo
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG or WebP images can be uploaded'));
    }
    cb(null, true);
  },
});

const uploadFromBuffer = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'gocha',
        resource_type: 'image', // never let Cloudinary infer something executable
      },
      (error, result) => (result ? resolve(result) : reject(error))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });

// POST /api/upload — vendor/admin only.
router.post('/', requireVendor, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        message: tooBig ? 'That image is larger than 5 MB.' : err.message || 'Upload failed',
      });
    }
    if (!req.file) return res.status(400).json({ message: 'No image file provided' });

    try {
      const result = await uploadFromBuffer(req.file.buffer);
      res.status(200).json({ message: 'Upload successful', url: result.secure_url });
    } catch (uploadErr) {
      // The Cloudinary error object can carry account details — log it, never
      // return it.
      console.error('Cloudinary upload error:', uploadErr);
      res.status(502).json({ message: 'Could not upload the image. Please try again.' });
    }
  });
});

module.exports = router;
