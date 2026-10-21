// src/services/imageUploadService.js — Server-side image compression + Cloudinary upload
//
// For images that pass through our server (admin task images), unlike
// routes/media.js where the app uploads straight to Cloudinary. Every
// image is resized to fit MAX_DIMENSION and re-encoded as WebP before
// upload, so a 5MB phone photo lands as a ~100-300KB file.

import sharp      from 'sharp';
import cloudinary from '../config/cloudinary.js';

const MAX_DIMENSION = 1080;
const WEBP_QUALITY  = 80;

export async function compressImage(buffer) {
  try {
    return await sharp(buffer)
      .rotate() // respect EXIF orientation before metadata is stripped
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new Error('INVALID_IMAGE');
  }
}

// Returns { url, public_id, replaced }. With `publicId` the existing
// Cloudinary image is overwritten in place (and its CDN cache purged)
// instead of a new file being created; the returned URL carries a new
// version so clients don't keep showing the old image.
export async function uploadCompressedImage(buffer, folder, { publicId = null } = {}) {
  const compressed = await compressImage(buffer);

  const options = publicId
    ? { public_id: publicId, overwrite: true, invalidate: true, resource_type: 'image', format: 'webp' }
    : { folder, resource_type: 'image', format: 'webp' };

  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, res) => (err ? reject(err) : resolve(res)))
      .end(compressed);
  });

  return { url: result.secure_url, public_id: result.public_id, replaced: Boolean(publicId) };
}

// public_id of an image we uploaded into `folder` on our own Cloudinary
// account, e.g. https://res.cloudinary.com/<cloud>/image/upload/v17.../hunterx/tasks/abc.webp
// -> 'hunterx/tasks/abc'. null for any other URL (external links, other
// folders), so we never overwrite or delete something we don't own.
export function ownPublicIdFromUrl(url, folder) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:.*?\/)?v\d+\/(.+)\.[a-z0-9]+$/i);
  if (!m || m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return null;
  return m[2].startsWith(`${folder}/`) ? m[2] : null;
}

// Best-effort cleanup, e.g. when the DB write after an upload fails.
export async function deleteImages(publicIds) {
  await Promise.allSettled(publicIds.map(id => cloudinary.uploader.destroy(id)));
}
