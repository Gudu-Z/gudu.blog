'use strict';

// These defaults apply before Waline reads its environment. Database credentials
// belong in the hosting provider, never in this directory or the static blog.
function applyDefaults(env) {
  const defaults = {
    SITE_NAME: 'Gudu 的个人博客',
    SITE_URL: 'https://gudu.blog',
    LOGIN: 'disable',
    COMMENT_AUDIT: 'true',
    IPQPS: '60',
    DISABLE_REGION: 'true',
    DISABLE_USERAGENT: 'true',
    SECURE_DOMAINS: 'gudu.blog',
    // Review and rate limiting work without sending comments to Akismet.
    AKISMET_KEY: 'false',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
}

function preSave(comment) {
  if (!comment || typeof comment.nick !== 'string' || !comment.nick.trim()) {
    return { errmsg: '请填写昵称。' };
  }
  comment.nick = comment.nick.trim();
  // Email stays optional. Waline owns content sanitization, thread handling,
  // moderation and persistence; this hook only adds the site's nickname rule.
}

module.exports = { applyDefaults, preSave };
