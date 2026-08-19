// ===== MTL Lab Inventory — v3.0.0 Firebase config =====
// Loaded AFTER the Firebase compat SDK script tags in index.html.
// Must never throw when the SDK scripts are unavailable (offline first paint):
// app.js then runs in localStorage-only mode.

const firebaseConfig = {
  apiKey: "AIzaSyAeekdjdWUOylbsh0tJspUc6Oh1IUMLJwk",
  authDomain: "mtl-lab-inventory.firebaseapp.com",
  projectId: "mtl-lab-inventory",
  storageBucket: "mtl-lab-inventory.firebasestorage.app",
  messagingSenderId: "412506950887",
  appId: "1:412506950887:web:996dbf1cf29d370a7ce642"
};

let db = null;             // Firestore instance; null when SDK missing / init failed
let firestoreReady = false;

if (typeof firebase !== 'undefined') {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  } catch (e) {
    console.error('Firebase init failed:', e);
    db = null;
  }
}

// Resolves true when an anonymous session is live. Called from app.js init().
function initFirebase() {
  if (!db) return Promise.resolve(false);
  return firebase.auth().signInAnonymously()
    .then(() => { firestoreReady = true; return true; })
    .catch(err => {
      console.error('Anonymous auth failed:', err);
      firestoreReady = false;
      return false;
    });
}
