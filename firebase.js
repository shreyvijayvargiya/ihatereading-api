import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import serviceAccount from "./service-account-file.js";
import { getDownloadURL, getStorage } from "firebase-admin/storage";

if (getApps().length === 0) {
	initializeApp({
		credential: cert(serviceAccount),
		projectId: process.env.FIREBASE_PROJECT_ID,
	});
}

const firestore = getFirestore();
const storage = getStorage();

export { firestore, storage, getDownloadURL };
