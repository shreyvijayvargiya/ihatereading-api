import { useEffect, useState } from "react";
import { Outlet } from "@tanstack/react-router";
import { AppNavbar, AppSidebar } from "@/components/AppShell";
import { CommandPalette } from "@/components/CommandPalette";

export function Layout() {
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return localStorage.getItem("monitor-sidebar") === "1";
		} catch {
			return false;
		}
	});
	const [searchOpen, setSearchOpen] = useState(false);

	useEffect(() => {
		localStorage.setItem("monitor-sidebar", collapsed ? "1" : "0");
	}, [collapsed]);

	function onMenu() {
		if (window.matchMedia("(min-width: 768px)").matches) {
			setCollapsed((v) => !v);
		} else {
			setMobileOpen((v) => !v);
		}
	}

	return (
		<div className="flex h-svh gap-3 overflow-hidden bg-zinc-100 p-3">
			<AppSidebar
				open={mobileOpen}
				collapsed={collapsed}
				onClose={() => setMobileOpen(false)}
				onToggle={onMenu}
			/>
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-white shadow-lg shadow-zinc-300/40">
				<AppNavbar onMenu={onMenu} onSearch={() => setSearchOpen(true)} />
				<main className="min-h-0 flex-1 overflow-hidden p-4">
					<Outlet />
				</main>
			</div>
			<CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
		</div>
	);
}
