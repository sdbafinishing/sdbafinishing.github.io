/**
 * SDBA RDMS — Web Build Configuration
 * These values are baked into the deployed web version.
 * Web users don't need to configure anything — they just open the URL.
 *
 * Local version ignores this file (uses IndexedDB config instead).
 *
 * IMPORTANT: Only put PUBLIC keys here. Never the service_role key.
 * Update these values before deploying to GitHub Pages.
 */

export const WEB_CONFIG = {
  // Supabase (public keys — safe to commit)
  supabase_url: 'https://twurfrztuvvbvotymvcf.supabase.co',      // e.g. 'https://xxxxx.supabase.co'
  supabase_anon_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3dXJmcnp0dXZ2YnZvdHltdmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMTM5NTIsImV4cCI6MjA5NDU4OTk1Mn0.qoDQjHga3viVQPAQLgIsuA6g5lMaNbjlPDPGYne6JHo', // e.g. 'eyJ...'

  // Google OAuth (public client ID — safe to commit)
  google_client_id: '762345466820-vlh5aossat5q82kuaan4mt57kckppfb4.apps.googleusercontent.com',  // e.g. '123456.apps.googleusercontent.com'

  // Firebase (public config — same as signal controller, safe to commit)
  firebase_config: {
    apiKey: 'AIzaSyBmRxbnhGwVeRlzkgCICuBGaMM7jBzWIKo',
    authDomain: 'dbracecontrol.firebaseapp.com',
    databaseURL: 'https://dbracecontrol-default-rtdb.firebaseio.com',
    projectId: 'dbracecontrol',
  },
};
