/**
 * config.js — single place to set the backend URL
 * Change BACKEND_URL to your Render URL after deploying:
 *   e.g. https://ttp-server.onrender.com
 */
window.TTP_BACKEND = window.TTP_BACKEND
  || localStorage.getItem('ttp_backend')
  || 'http://localhost:4747';
