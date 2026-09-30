// Firebase bootstrap only: SDK loading and Firebase store startup.
// UI failure handling stays in index.html; pass callbacks rather than importing DOM code.
import { makeFirebaseStore } from "./store.js";

async function loadFirebase(cfg){
  // Fetched in parallel rather than one-after-another — on the patchy
  // connectivity this app is built for (see README), three sequential CDN
  // round-trips could burn through more of the 15s init timeout than
  // necessary and fall back to local test mode on a connection that would
  // have been fine given all three requests at once.
  const [appMod, authMod, fsMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
  ]);
  const app  = appMod.initializeApp(cfg);
  const auth = authMod.getAuth(app);
  // Firestore offline persistence: keeps the dashboard usable and queues writes
  // on the patchy connections this app is built for, then syncs automatically.
  // The multi-tab manager lets a PWA opened in several tabs share the cache
  // instead of fighting over it. If persistence can't start (IndexedDB blocked,
  // private mode, old browser), fall back to the in-memory cache so the app
  // still runs.
  let db;
  try{
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
    });
  }catch(err){
    console.warn("Firestore offline persistence unavailable; using in-memory cache.", err);
    db = fsMod.getFirestore(app);
  }
  return { auth, db, fs:fsMod, au:authMod };
}

const firebaseConfig = {
  apiKey: "AIzaSyARuyCACcu7-y0gYBFiDRnkEuIWTO_NJKA",
  authDomain: "nsnvc-contribution.firebaseapp.com",
  projectId: "nsnvc-contribution",
  storageBucket: "nsnvc-contribution.firebasestorage.app",
  messagingSenderId: "686034384332",
  appId: "1:686034384332:web:06e629117b63ba615c5969"
};

export { firebaseConfig };

export async function initFirebaseStoreWithRetry({ classifyError, onFailure } = {}) {
  const classify = typeof classifyError === "function" ? classifyError : (() => "unknown");
  const fail = typeof onFailure === "function" ? onFailure : (() => {});
  const attempts = 3;
  let lastErr = null;
  for(let i=1;i<=attempts;i++){
    try{
      console.log(`Initializing Firebase (attempt ${i}/${attempts})...`);
      const fbModule = await Promise.race([
        loadFirebase(firebaseConfig),
        new Promise((_,reject) => setTimeout(()=>reject(new Error("timeout after 15s")), 15000))
      ]);
      console.log("Firebase loaded successfully");
      return makeFirebaseStore(fbModule);
    }catch(err){
      lastErr = err;
      console.error(`Firebase initialization attempt ${i} failed:`, err);
      if(classify(err) !== "offline") break;
      if(i < attempts){
        await new Promise(r=>setTimeout(r, 1500*i));
      }
    }
  }
  fail(lastErr);
  return null;
}
