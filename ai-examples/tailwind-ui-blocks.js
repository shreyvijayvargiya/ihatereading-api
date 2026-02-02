/**
 * SIMBA UI BLOCK LIBRARY
 * Standardized structure for semantic search: { code: string, tags: string[] }
 */

export const uiBlocks = {
	"button-primary": {
		tags: ["button", "primary", "cta", "zinc", "rounded-xl", "shadow"],
		code: `
<!-- Primary Button -->
<button class="flex items-center gap-2 rounded-xl bg-zinc-900 px-6 py-3 font-bold text-white transition-all hover:scale-[1.02] active:scale-95 hover:bg-zinc-800 shadow-lg shadow-zinc-200">
  <span>Get Started</span>
  <img src="https://unpkg.com/lucide-static@latest/icons/arrow-right.svg" class="h-5 w-5 invert" />
</button>`,
	},

	"button-secondary": {
		tags: ["button", "secondary", "outline", "white", "rounded-xl"],
		code: `
<!-- Secondary/Outline Button -->
<button class="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 font-bold text-zinc-900 transition-all hover:bg-zinc-50 hover:border-zinc-300">
  <img src="https://unpkg.com/lucide-static@latest/icons/play.svg" class="h-5 w-5" />
  <span>Watch Demo</span>
</button>`,
	},

	"card-bento": {
		tags: ["card", "bento", "feature", "high-end", "zinc", "rounded-3xl"],
		code: `
<!-- HIGH-END CARDS (BENTO STYLE) -->
<div class="group rounded-[2.5rem] border border-zinc-100 bg-zinc-50/50 p-10 backdrop-blur-sm hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 border-b-4 border-b-zinc-200">
  <div class="w-14 h-14 mb-8 bg-zinc-900 rounded-2xl flex items-center justify-center group-hover:rotate-12 transition-transform shadow-xl shadow-zinc-200">
    <img src="https://unpkg.com/lucide-static@latest/icons/layers.svg" class="w-7 h-7 invert">
  </div>
  <h3 class="text-2xl font-bold text-zinc-900 mb-4 tracking-tight">Modular Architecture</h3>
  <p class="text-zinc-500 leading-relaxed">Build scalable systems with our atomized component library. Designed for high-performance enterprise applications.</p>
</div>`,
	},

	"input-search": {
		tags: ["input", "search", "form", "zinc", "rounded-2xl"],
		code: `
<!-- INPUT WITH CONTEXTUAL ICON -->
<div class="relative w-full max-w-md group">
  <div class="absolute left-4 top-1/2 -translate-y-1/2 transition-transform group-focus-within:scale-110">
    <img src="https://unpkg.com/lucide-static@latest/icons/search.svg" class="w-5 h-5 text-zinc-400">
  </div>
  <input type="text" placeholder="Search resources..." class="w-full pl-12 pr-4 py-4 bg-zinc-50 border border-zinc-200 rounded-2xl outline-none transition-all focus:ring-4 focus:ring-zinc-900/5 focus:border-zinc-900 focus:bg-white text-zinc-900 font-medium" />
  <kbd class="absolute right-4 top-1/2 -translate-y-1/2 px-2 py-1 bg-zinc-200 rounded text-[10px] font-bold text-zinc-500 border border-zinc-300">CMD + K</kbd>
</div>`,
	},

	"tabs-pill": {
		tags: ["tabs", "pill", "navigation", "zinc", "rounded-2xl"],
		code: `
<!-- PILL TABS WITH ICONS -->
<div class="inline-flex p-1 bg-zinc-100 rounded-2xl border border-zinc-200">
  <button class="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-white shadow-sm text-zinc-900 font-bold transition-all">
    <img src="https://unpkg.com/lucide-static@latest/icons/layout-grid.svg" class="w-4 h-4" />
    <span>Grid View</span>
  </button>
  <button class="flex items-center gap-2 px-6 py-2.5 rounded-xl text-zinc-500 font-bold hover:text-zinc-900 transition-all">
    <img src="https://unpkg.com/lucide-static@latest/icons/list.svg" class="w-4 h-4 text-zinc-400" />
    <span>List View</span>
  </button>
</div>`,
	},

	"pricing-card": {
		tags: ["pricing", "card", "plan", "zinc", "rounded-3xl"],
		code: `
<!-- PRICING CARD WITH ICON LISTS & TOGGLE -->
<div class="bg-white rounded-[3rem] border-2 border-zinc-900 p-10 shadow-2xl shadow-zinc-200 relative overflow-hidden">
  <div class="absolute top-0 right-0 px-6 py-2 bg-zinc-900 text-white text-xs font-black uppercase tracking-widest rounded-bl-2xl">Most Popular</div>
  <h4 class="text-zinc-500 font-bold uppercase tracking-widest text-xs mb-4">Professional</h4>
  <div class="flex items-baseline gap-1 mb-8">
    <span class="text-5xl font-black text-zinc-900">$49</span>
    <span class="text-zinc-400 font-bold">/mo</span>
  </div>
  <ul class="space-y-4 mb-10">
    <li class="flex items-center gap-3 text-zinc-700 font-medium">
      <img src="https://unpkg.com/lucide-static@latest/icons/check-circle.svg" class="w-5 h-5 text-zinc-900" />
      <span>Unlimited Projects</span>
    </li>
    <li class="flex items-center gap-3 text-zinc-700 font-medium">
      <img src="https://unpkg.com/lucide-static@latest/icons/check-circle.svg" class="w-5 h-5 text-zinc-900" />
      <span>Advanced Analytics</span>
    </li>
  </ul>
  <button class="w-full py-4 bg-zinc-900 text-white rounded-2xl font-black hover:bg-zinc-800 transition-all shadow-xl shadow-zinc-200">
    Upgrade to Pro
  </button>
</div>`,
	},

	"hero-centered": {
		tags: ["hero", "centered", "marketing", "zinc", "rounded-2xl"],
		code: `
<!-- HERO SECTION (CENTERED) -->
<section class="pt-32 pb-20 px-6 overflow-hidden">
  <div class="max-w-4xl mx-auto text-center relative">
    <div class="absolute -top-20 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-zinc-100 rounded-full blur-[120px] -z-10 opacity-50"></div>
    <h1 class="text-6xl md:text-8xl font-black text-zinc-900 tracking-tighter mb-8 leading-[0.9]">Design at the speed of <span class="text-zinc-400 italic">thought.</span></h1>
    <p class="text-xl text-zinc-500 max-w-2xl mx-auto leading-relaxed mb-12 font-medium">Ship high-end production interfaces in minutes, not weeks. The world's most advanced design-to-code engine for modern teams.</p>
    <div class="flex flex-col sm:flex-row justify-center gap-4">
      <button class="bg-zinc-900 text-white px-10 py-5 rounded-2xl font-black text-xl hover:bg-zinc-800 transition-all shadow-2xl shadow-zinc-200">Start Building Free</button>
      <button class="bg-white border border-zinc-200 text-zinc-900 px-10 py-5 rounded-2xl font-black text-xl hover:bg-zinc-50 transition-all">Talk to Sales</button>
    </div>
  </div>
</section>`,
	},

	"navbar-premium": {
		tags: ["navbar", "navigation", "fixed", "zinc", "backdrop-blur"],
		code: `
<!-- PREMIUM NAVBAR -->
<nav class="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-xl border-b border-zinc-100 px-6 py-4">
  <div class="max-w-7xl mx-auto flex justify-between items-center">
    <div class="flex items-center gap-2 font-black text-2xl tracking-tighter">
      <div class="w-8 h-8 bg-zinc-900 rounded-lg"></div>
      SIMBA
    </div>
    <div class="hidden md:flex gap-8 items-center text-sm font-bold text-zinc-500">
      <a href="#" class="text-zinc-900 hover:text-zinc-600 transition-colors">Product</a>
      <a href="#" class="hover:text-zinc-900 transition-colors">Solutions</a>
      <a href="#" class="hover:text-zinc-900 transition-colors">Pricing</a>
    </div>
    <div class="flex items-center gap-4">
      <button class="text-sm font-bold text-zinc-900 px-4 py-2">Sign In</button>
      <button class="bg-zinc-900 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-zinc-200 hover:bg-zinc-800 transition-all">Get Started</button>
    </div>
  </div>
</nav>`,
	},
};

/**
 * BRUTAL DESIGN SYSTEM (Gumroad Style)
 */
export const uiBlocksBrutal = {
	"button-primary": {
		tags: [
			"brutal",
			"button",
			"primary",
			"yellow",
			"black-border",
			"no-radius",
		],
		code: `
<button class="flex items-center gap-2 rounded-none border-4 border-black bg-yellow-400 px-8 py-4 font-black text-black transition-all hover:-translate-x-1 hover:-translate-y-1 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-0 active:translate-y-0">
  <span>GET STARTED</span>
  <img src="https://unpkg.com/lucide-static@latest/icons/arrow-right.svg" class="h-6 w-6 stroke-[3]" />
</button>`,
	},
	"card-bento": {
		tags: ["brutal", "card", "bento", "white", "black-border", "shadow"],
		code: `
<div class="rounded-none border-4 border-black bg-white p-10 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] transition-all">
  <div class="w-16 h-16 mb-8 bg-purple-400 border-4 border-black flex items-center justify-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
    <img src="https://unpkg.com/lucide-static@latest/icons/zap.svg" class="w-8 h-8">
  </div>
  <h3 class="text-3xl font-black text-black mb-4 uppercase italic">Ultra Fast Execution</h3>
  <p class="text-black font-bold leading-tight">Optimized for high-speed delivery and zero latency. No fluff, just performance.</p>
</div>`,
	},
	"navbar-brutal": {
		tags: ["brutal", "navbar", "navigation", "yellow", "black-border"],
		code: `
<nav class="border-b-8 border-black bg-white px-8 py-6">
  <div class="max-w-7xl mx-auto flex justify-between items-center">
    <div class="text-4xl font-black italic tracking-tighter bg-yellow-400 border-4 border-black px-4 py-1 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">BRUTAL.</div>
    <div class="hidden md:flex gap-10 font-black uppercase italic">
      <a href="#" class="hover:bg-cyan-300 px-2">Work</a>
      <a href="#" class="hover:bg-lime-400 px-2">About</a>
      <a href="#" class="hover:bg-pink-400 px-2">Pricing</a>
    </div>
    <button class="border-4 border-black bg-black text-white px-6 py-2 font-black uppercase hover:bg-white hover:text-black transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none">Login</button>
  </div>
</nav>`,
	},
	"hero-brutal": {
		tags: ["brutal", "hero", "marketing", "yellow", "cyan", "black-border"],
		code: `
<section class="py-24 px-8 bg-cyan-300 border-b-8 border-black">
  <div class="max-w-5xl mx-auto text-center">
    <h1 class="text-7xl md:text-9xl font-black text-black leading-none uppercase italic mb-12 shadow-white drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Stop playing <br/> <span class="bg-yellow-400 border-4 border-black px-4">safe.</span></h1>
    <p class="text-2xl font-black text-black mb-12 max-w-2xl mx-auto border-4 border-black bg-white p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">The world belongs to the bold. Build interfaces that demand attention and refuse to be ignored.</p>
    <div class="flex flex-col sm:flex-row justify-center gap-6">
      <button class="bg-black text-white text-3xl font-black px-12 py-6 border-4 border-black shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all">JOIN NOW</button>
      <button class="bg-white text-black text-3xl font-black px-12 py-6 border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all">LEARN MORE</button>
    </div>
  </div>
</section>`,
	},
};

/**
 * MINIMALIST DESIGN SYSTEM (Notion Style)
 */
export const uiBlocksMinimal = {
	"button-primary": {
		tags: ["minimal", "button", "primary", "zinc", "rounded-md", "notion"],
		code: `
<button class="flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors">
  <span>New Page</span>
  <img src="https://unpkg.com/lucide-static@latest/icons/plus.svg" class="h-4 w-4 invert" />
</button>`,
	},
	"card-bento": {
		tags: ["minimal", "card", "bento", "zinc", "rounded-xl"],
		code: `
<div class="group rounded-xl border border-zinc-200 bg-white p-6 hover:bg-zinc-50 transition-colors">
  <div class="w-10 h-10 mb-4 bg-zinc-100 rounded-lg flex items-center justify-center">
    <img src="https://unpkg.com/lucide-static@latest/icons/book-open.svg" class="w-5 h-5 text-zinc-600">
  </div>
  <h3 class="text-lg font-semibold text-zinc-900 mb-2">Knowledge Base</h3>
  <p class="text-sm text-zinc-500 leading-relaxed">Centralize your team's documentation and guides in one organized place.</p>
</div>`,
	},
	"navbar-minimal": {
		tags: ["minimal", "navbar", "navigation", "zinc", "white"],
		code: `
<nav class="border-b border-zinc-200 bg-white/50 backdrop-blur-sm px-4 py-3">
  <div class="max-w-7xl mx-auto flex justify-between items-center">
    <div class="flex items-center gap-2 font-semibold text-zinc-900">
      <img src="https://unpkg.com/lucide-static@latest/icons/box.svg" class="w-5 h-5" />
      <span>Minimal</span>
    </div>
    <div class="flex gap-6 text-sm text-zinc-500 font-medium">
      <a href="#" class="hover:text-zinc-900 transition-colors">Docs</a>
      <a href="#" class="hover:text-zinc-900 transition-colors">Templates</a>
      <a href="#" class="hover:text-zinc-900 transition-colors">API</a>
    </div>
    <div class="flex items-center gap-3">
      <button class="text-sm font-medium text-zinc-500 hover:text-zinc-900">Log in</button>
      <button class="bg-zinc-900 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-zinc-800">Sign up</button>
    </div>
  </div>
</nav>`,
	},
};

/**
 * CYBERPUNK DESIGN SYSTEM
 */
export const uiBlocksCyber = {
	"hero-centered": {
		tags: ["cyber", "hero", "dark", "neon", "cyan", "fuchsia"],
		code: `
<section class="bg-black py-32 px-6 relative overflow-hidden">
  <div class="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
  <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-cyan-500/10 rounded-full blur-[120px]"></div>
  <div class="max-w-4xl mx-auto text-center relative z-10">
    <div class="inline-block px-4 py-1 border border-cyan-500/30 bg-cyan-500/5 text-cyan-400 text-[10px] font-mono uppercase tracking-[0.3em] mb-8">System Status: Optimal</div>
    <h1 class="text-6xl md:text-8xl font-black text-white tracking-tighter mb-8 uppercase leading-none">Execute the <span class="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-fuchsia-500">Future.</span></h1>
    <p class="text-zinc-400 text-lg max-w-2xl mx-auto mb-12 font-mono">Quantum-grade infrastructure for the next generation of decentralized applications. High-bandwidth, low-latency, zero-compromise.</p>
    <div class="flex flex-col sm:flex-row justify-center gap-6">
      <button class="bg-cyan-500 text-black px-10 py-4 font-black uppercase tracking-widest hover:bg-cyan-400 transition-all shadow-[0_0_20px_rgba(6,182,212,0.5)]">Initialize</button>
      <button class="border border-fuchsia-500 text-fuchsia-500 px-10 py-4 font-black uppercase tracking-widest hover:bg-fuchsia-500/10 transition-all shadow-[0_0_20px_rgba(217,70,239,0.2)]">Documentation</button>
    </div>
  </div>
</section>`,
	},
	"metric-card": {
		tags: ["cyber", "metric", "card", "data", "neon", "cyan"],
		code: `
<div class="bg-zinc-900 border-l-4 border-cyan-500 p-6 shadow-2xl relative group overflow-hidden">
  <div class="absolute inset-0 bg-gradient-to-r from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
  <div class="flex justify-between items-start mb-4">
    <div class="text-[10px] font-mono text-cyan-500/50 uppercase">Network Load</div>
    <div class="text-cyan-500 animate-pulse">
      <img src="https://unpkg.com/lucide-static@latest/icons/activity.svg" class="w-4 h-4" />
    </div>
  </div>
  <div class="text-4xl font-black text-white mb-2 font-mono">84.2<span class="text-sm text-cyan-500">TH/s</span></div>
  <div class="w-full h-1 bg-zinc-800 mt-4 relative">
    <div class="absolute inset-y-0 left-0 bg-cyan-500 w-[84%] shadow-[0_0_10px_#06b6d4]"></div>
  </div>
</div>`,
	},
	"navbar-cyber": {
		tags: ["cyber", "navbar", "dark", "neon", "cyan"],
		code: `
<nav class="bg-black border-b border-cyan-500/30 px-6 py-4 relative">
  <div class="absolute bottom-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-cyan-500 to-transparent"></div>
  <div class="max-w-7xl mx-auto flex justify-between items-center">
    <div class="flex items-center gap-4">
      <div class="w-10 h-10 border border-cyan-500 rotate-45 flex items-center justify-center">
        <div class="w-6 h-6 bg-cyan-500 -rotate-45"></div>
      </div>
      <span class="text-2xl font-black tracking-widest text-white uppercase italic">CyberOS</span>
    </div>
    <div class="hidden md:flex gap-10 text-[10px] font-mono uppercase tracking-[0.4em] text-cyan-500/60">
      <a href="#" class="hover:text-cyan-400 transition-colors">Nodes</a>
      <a href="#" class="hover:text-cyan-400 transition-colors">Protocols</a>
      <a href="#" class="hover:text-cyan-400 transition-colors">Mainnet</a>
    </div>
    <button class="px-6 py-2 border border-cyan-500 text-cyan-500 font-mono text-xs uppercase tracking-widest hover:bg-cyan-500 hover:text-black transition-all">Connect Wallet</button>
  </div>
</nav>`,
	},
};

/**
 * GAIA DESIGN SYSTEM (Earthy/Organic)
 */
export const uiBlocksGaia = {
	"feature-grid": {
		tags: ["gaia", "feature", "grid", "organic", "leaf", "sustainable"],
		code: `
<div class="grid grid-cols-1 md:grid-cols-3 gap-12">
  <div class="text-center group">
    <div class="w-20 h-20 bg-[#E8F3EE] rounded-full mx-auto mb-8 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
      <img src="https://unpkg.com/lucide-static@latest/icons/leaf.svg" class="w-8 h-8 text-[#4A6D5C]" />
    </div>
    <h3 class="text-2xl font-bold text-[#2D3A33] mb-4">Sustainable Growth</h3>
    <p class="text-[#5C7066] leading-relaxed">Built with the environment in mind. We prioritize longevity and ethical scaling for all partners.</p>
  </div>
</div>`,
	},
};

/**
 * JOY DESIGN SYSTEM (Playful/Bouncy)
 */
export const uiBlocksJoy = {
	"hero-split": {
		tags: ["joy", "hero", "playful", "pink", "yellow", "bouncy"],
		code: `
<section class="max-w-7xl mx-auto py-20 px-6 grid md:grid-cols-2 gap-12 items-center">
  <div class="space-y-8">
    <div class="inline-block px-4 py-2 bg-yellow-300 rounded-full font-black uppercase text-xs tracking-tighter -rotate-2 border-2 border-black">Wooohooo! It's here!</div>
    <h1 class="text-6xl md:text-8xl font-black text-black tracking-tight leading-[0.85] uppercase">Make your <br/> ideas <span class="text-blue-500 underline decoration-pink-500 decoration-8 underline-offset-4">POP!</span></h1>
    <p class="text-xl font-bold text-zinc-600 leading-relaxed max-w-md">The most colorful way to build apps that users actually LOVE. Fun included by default! 🎉</p>
    <div class="flex gap-4">
      <button class="bg-pink-500 text-white px-8 py-5 rounded-3xl font-black text-xl border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all">LET'S GO!</button>
      <div class="flex items-center gap-2 font-black text-black cursor-pointer hover:rotate-3 transition-transform">
        <img src="https://unpkg.com/lucide-static@latest/icons/play-circle.svg" class="w-10 h-10 text-blue-500" />
        <span>WATCH FUN</span>
      </div>
    </div>
  </div>
  <div class="relative bg-blue-100 rounded-[4rem] p-12 border-8 border-white shadow-2xl rotate-2">
    <div class="grid grid-cols-2 gap-6">
      <div class="h-40 bg-yellow-300 rounded-3xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"></div>
      <div class="h-40 bg-pink-400 rounded-3xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] -mt-12"></div>
      <div class="h-40 bg-white rounded-3xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"></div>
      <div class="h-40 bg-black rounded-3xl border-4 border-white -mt-12"></div>
    </div>
  </div>
</section>`,
	},
};

/**
 * MODERN DESIGN SYSTEM
 */
export const uiBlocksModern = {
	"hero-centered": {
		tags: ["modern", "hero", "sleek", "typography", "high-end"],
		code: `
<section class="py-32 px-6 bg-white overflow-hidden">
  <div class="max-w-6xl mx-auto text-center">
    <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-zinc-100 bg-zinc-50 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400 mb-12">Built for the next generation</div>
    <h1 class="text-7xl md:text-9xl font-black text-zinc-900 tracking-tight leading-none mb-12">Design is <br/> <span class="text-zinc-200">Invisible.</span></h1>
    <div class="flex flex-col md:flex-row justify-center items-center gap-12 mt-20 border-t border-zinc-100 pt-12">
      <div class="text-left max-w-xs">
        <p class="text-sm text-zinc-500 leading-relaxed">Our minimalist approach ensures that your content remains the hero. No distractions, just pure performance.</p>
      </div>
      <button class="bg-zinc-900 text-white px-12 py-6 rounded-full font-bold text-xl hover:bg-zinc-800 transition-all shadow-2xl">Start your project</button>
      <div class="text-left max-w-xs">
        <p class="text-sm text-zinc-500 leading-relaxed">Join 2,000+ companies already building with our modern framework.</p>
      </div>
    </div>
  </div>
</section>`,
	},
};

/**
 * KIDS DESIGN SYSTEM
 */
export const uiBlocksKids = {
	"hero-split": {
		tags: ["kids", "hero", "playful", "orange", "blue", "magic"],
		code: `
<section class="max-w-7xl mx-auto py-20 px-6 grid md:grid-cols-2 gap-12 items-center">
  <div class="bg-orange-100 rounded-[4rem] p-12 border-4 border-orange-200 shadow-xl">
    <h1 class="text-5xl md:text-7xl font-black text-orange-600 tracking-tight mb-8">Ready to <span class="text-blue-500">Play</span> and <span class="text-pink-500">Learn?</span></h1>
    <p class="text-2xl font-bold text-orange-900/60 leading-relaxed mb-10">The most magical place for little explorers to discover the world! 🎈</p>
    <button class="bg-blue-500 text-white px-10 py-6 rounded-full font-black text-2xl border-b-8 border-blue-700 hover:border-b-4 hover:translate-y-1 transition-all shadow-xl shadow-blue-200">LET'S START! 🚀</button>
  </div>
  <div class="relative flex justify-center">
    <div class="w-80 h-80 bg-yellow-300 rounded-full border-8 border-white shadow-2xl flex items-center justify-center animate-bounce">
      <img src="https://unpkg.com/lucide-static@latest/icons/smile.svg" class="w-40 h-40 text-orange-500" />
    </div>
  </div>
</section>`,
	},
};

/**
 * EDUCATION DESIGN SYSTEM
 */
export const uiBlocksEducation = {
	"data-table": {
		tags: ["education", "table", "courses", "professional", "blue"],
		code: `
<div class="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
  <div class="p-6 border-b border-zinc-100 bg-zinc-50 flex justify-between items-center">
    <h3 class="font-bold text-zinc-900 uppercase tracking-widest text-xs">Available Courses</h3>
    <button class="text-xs font-bold text-blue-600 hover:underline">View All</button>
  </div>
  <table class="w-full text-left">
    <thead>
      <tr class="text-[10px] font-black text-zinc-400 uppercase tracking-widest border-b border-zinc-100">
        <th class="px-8 py-4">Course Name</th>
        <th class="px-8 py-4">Duration</th>
        <th class="px-8 py-4">Difficulty</th>
      </tr>
    </thead>
    <tbody class="text-sm font-medium text-zinc-600 divide-y divide-zinc-50">
      <tr class="hover:bg-zinc-50 transition-colors">
        <td class="px-8 py-6 text-zinc-900 font-bold">Advanced Mathematics</td>
        <td class="px-8 py-6">12 Weeks</td>
        <td class="px-8 py-6"><span class="px-3 py-1 bg-red-50 text-red-600 rounded-full text-[10px] font-black">Expert</span></td>
      </tr>
      <tr class="hover:bg-zinc-50 transition-colors">
        <td class="px-8 py-6 text-zinc-900 font-bold">World History I</td>
        <td class="px-8 py-6">8 Weeks</td>
        <td class="px-8 py-6"><span class="px-3 py-1 bg-green-50 text-green-600 rounded-full text-[10px] font-black">Beginner</span></td>
      </tr>
    </tbody>
  </table>
</div>`,
	},
};

/**
 * SPORTS DESIGN SYSTEM
 */
export const uiBlocksSports = {
	"hero-split": {
		tags: ["sports", "hero", "power", "red", "black", "italic", "skew"],
		code: `
<section class="bg-zinc-900 py-24 px-8 relative skew-y-[-2deg] -mt-12">
  <div class="skew-y-[2deg] max-w-7xl mx-auto grid md:grid-cols-2 gap-12 items-center">
    <div>
      <h1 class="text-7xl md:text-9xl font-black text-white italic tracking-tighter uppercase mb-6 leading-none">Limitless <br/> <span class="text-red-600">Power.</span></h1>
      <p class="text-xl text-zinc-400 font-bold italic mb-10 max-w-md">Push beyond your boundaries with our pro-athlete training systems. Scientifically proven results.</p>
      <button class="bg-red-600 text-white px-10 py-5 rounded-none font-black text-2xl uppercase skew-x-[-12deg] hover:bg-red-700 transition-all shadow-[8px_8px_0px_0px_rgba(255,255,255,0.2)]">Join the team</button>
    </div>
    <div class="relative">
      <div class="aspect-video bg-zinc-800 rounded-none border-t-8 border-red-600 overflow-hidden skew-x-[-6deg] shadow-2xl">
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
        <div class="absolute bottom-8 left-8 text-white">
          <div class="text-[10px] font-black uppercase tracking-[0.3em] text-red-500 mb-2">Live Training</div>
          <div class="text-3xl font-black italic uppercase">HIIT: Ultra Burn</div>
        </div>
      </div>
    </div>
  </div>
</section>`,
	},
};

/**
 * FINANCE DESIGN SYSTEM
 */
export const uiBlocksFinance = {
	"comparison-table": {
		tags: ["finance", "table", "growth", "secure", "emerald", "navy"],
		code: `
<div class="bg-slate-900 rounded-3xl p-10 border border-slate-800 shadow-2xl">
  <div class="text-center mb-12">
    <h2 class="text-3xl font-bold text-white mb-4">Choose your growth path</h2>
    <p class="text-slate-400">Secure assets, transparent fees, institutional-grade security.</p>
  </div>
  <div class="grid md:grid-cols-2 gap-8">
    <div class="p-8 rounded-2xl bg-slate-800/50 border border-slate-700 hover:border-emerald-500/50 transition-all">
      <h3 class="text-xl font-bold text-white mb-2">Personal</h3>
      <div class="text-4xl font-black text-emerald-400 mb-8">$0 <span class="text-sm font-normal text-slate-500">/mo</span></div>
      <ul class="space-y-4 mb-10 text-slate-300 text-sm">
        <li class="flex items-center gap-3"><img src="https://unpkg.com/lucide-static@latest/icons/shield-check.svg" class="w-4 h-4 text-emerald-500" /> Standard Security</li>
        <li class="flex items-center gap-3"><img src="https://unpkg.com/lucide-static@latest/icons/shield-check.svg" class="w-4 h-4 text-emerald-500" /> Basic Analytics</li>
      </ul>
      <button class="w-full py-4 bg-white text-slate-900 rounded-xl font-bold hover:bg-slate-100 transition-colors">Start for free</button>
    </div>
    <div class="p-8 rounded-2xl bg-emerald-500 border border-emerald-400">
      <h3 class="text-xl font-bold text-emerald-950 mb-2">Institutional</h3>
      <div class="text-4xl font-black text-emerald-950 mb-8">$499 <span class="text-sm font-normal text-emerald-900/50">/mo</span></div>
      <ul class="space-y-4 mb-10 text-emerald-950/70 text-sm">
        <li class="flex items-center gap-3 font-bold"><img src="https://unpkg.com/lucide-static@latest/icons/shield-alert.svg" class="w-4 h-4" /> Priority Support</li>
        <li class="flex items-center gap-3 font-bold"><img src="https://unpkg.com/lucide-static@latest/icons/database.svg" class="w-4 h-4" /> Multi-sig Vault</li>
      </ul>
      <button class="w-full py-4 bg-emerald-950 text-white rounded-xl font-bold hover:bg-emerald-900 transition-colors shadow-xl">Get Started</button>
    </div>
  </div>
</div>`,
	},
};

/**
 * HEALTH DESIGN SYSTEM
 */
export const uiBlocksHealth = {
	"hero-split": {
		tags: ["health", "hero", "vital", "teal", "white", "calm", "medical"],
		code: `
<section class="max-w-7xl mx-auto py-24 px-8 flex flex-col md:flex-row items-center gap-20">
  <div class="flex-1 space-y-8">
    <div class="w-16 h-1 bg-teal-500"></div>
    <h1 class="text-6xl font-black text-slate-900 tracking-tight leading-none">Better care for a <span class="text-teal-500">healthier life.</span></h1>
    <p class="text-xl text-slate-500 font-medium leading-relaxed max-w-lg">Connect with world-class medical professionals from the comfort of your home. Secure, private, and compassionate.</p>
    <div class="flex gap-4">
      <button class="bg-teal-500 text-white px-10 py-5 rounded-2xl font-bold text-lg hover:bg-teal-600 transition-all shadow-xl shadow-teal-100">Book Appointment</button>
      <button class="text-slate-900 px-10 py-5 font-bold hover:bg-slate-50 rounded-2xl transition-all">Our services</button>
    </div>
  </div>
  <div class="flex-1 relative">
    <div class="bg-teal-50 rounded-[3rem] p-12 aspect-square flex items-center justify-center">
       <div class="w-full h-full bg-white rounded-[2rem] shadow-2xl p-8">
          <div class="flex items-center gap-4 mb-8">
            <div class="w-12 h-12 bg-teal-100 rounded-full flex items-center justify-center">
               <img src="https://unpkg.com/lucide-static@latest/icons/user-check.svg" class="w-6 h-6 text-teal-600" />
            </div>
            <div>
              <div class="font-bold text-slate-900">Dr. Emily Chen</div>
              <div class="text-xs text-slate-400 font-medium">Cardiologist</div>
            </div>
          </div>
          <div class="space-y-4">
             <div class="h-4 bg-slate-50 rounded-full w-full"></div>
             <div class="h-4 bg-slate-50 rounded-full w-2/3"></div>
             <div class="h-32 bg-teal-50/30 rounded-2xl border-2 border-dashed border-teal-100 flex items-center justify-center text-teal-300 font-bold uppercase text-xs tracking-widest">Medical Record</div>
          </div>
       </div>
    </div>
  </div>
</section>`,
	},
};

/**
 * CONSOLIDATED LIBRARY FOR SEMANTIC SEARCH
 */
export const uiBlockLibrary = [
	...Object.entries(uiBlocks).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksBrutal).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksMinimal).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksCyber).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksGaia).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksJoy).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksModern).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksKids).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksEducation).map(([name, data]) => ({
		name,
		...data,
	})),
	...Object.entries(uiBlocksSports).map(([name, data]) => ({ name, ...data })),
	...Object.entries(uiBlocksFinance).map(([name, data]) => ({
		name,
		...data,
	})),
	...Object.entries(uiBlocksHealth).map(([name, data]) => ({ name, ...data })),
];

// For backward compatibility
export const tailwindUIBlocks = uiBlockLibrary.map((b) => b.code).join("\n\n");
