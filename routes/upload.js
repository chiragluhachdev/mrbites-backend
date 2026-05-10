const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Multer (memory storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// POST /api/upload
router.post('/', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  const uploadFromBuffer = (req) => {
    return new Promise((resolve, reject) => {
      const cld_upload_stream = cloudinary.uploader.upload_stream(
        { folder: 'gocha' },
        (error, result) => {
          if (result) {
            resolve(result);
          } else {
            reject(error);
          }
        }
      );

      streamifier.createReadStream(req.file.buffer).pipe(cld_upload_stream);
    });
  };

  uploadFromBuffer(req)
    .then((result) => {
      res.status(200).json({ 
        message: 'Upload successful', 
        url: result.secure_url 
      });
    })
    .catch((error) => {
      console.error('Cloudinary upload error:', error);
      res.status(500).json({ message: 'Error uploading image to Cloudinary', error });
    });
});

module.exports = router;
