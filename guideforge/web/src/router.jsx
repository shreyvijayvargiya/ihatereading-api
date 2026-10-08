import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "./layouts/AppShell.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { NewGuidePage } from "./pages/NewGuidePage.jsx";
import { ResearchListPage } from "./pages/ResearchListPage.jsx";
import { ResearchJobPage } from "./pages/ResearchJobPage.jsx";
import { GuidesPage } from "./pages/GuidesPage.jsx";
import { GuideDetailPage } from "./pages/GuideDetailPage.jsx";
import { GuideEditorPage } from "./pages/GuideEditorPage.jsx";
import { GuideImagesPage } from "./pages/GuideImagesPage.jsx";
import { SettingsPage } from "./pages/SettingsPage.jsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "new", element: <NewGuidePage /> },
      { path: "research", element: <ResearchListPage /> },
      { path: "research/:id", element: <ResearchJobPage /> },
      { path: "guides", element: <GuidesPage /> },
      { path: "guides/:slug", element: <GuideDetailPage /> },
      { path: "guides/:slug/research", element: <GuideDetailPage /> },
      { path: "guides/:slug/images", element: <GuideImagesPage /> },
      { path: "guides/:slug/editor", element: <GuideEditorPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
