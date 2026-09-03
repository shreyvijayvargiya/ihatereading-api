import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import serviceAccount from "./service-account-file.js";
import { getDownloadURL, getStorage } from "firebase-admin/storage";

if (getApps().length === 0) {
	initializeApp({
		credential: cert(serviceAccount),
		projectId: process.env.FIREBASE_PROJECT_ID || "ihatereading-4ba52",
	});
}

const firestore = getFirestore();
// Must run before any Firestore read/write in this process.
firestore.settings({ ignoreUndefinedProperties: true });

const storage = getStorage();
const auth = getAuth();

export { firestore, storage, getDownloadURL, auth };
