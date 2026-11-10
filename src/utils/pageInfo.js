// src/utils/pageInfo.js — Pagination metadata, same shape as the admin users list.
export function pageInfo(page, limit, total) {
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total_count: total, total_pages: totalPages, has_next_page: page < totalPages };
}
