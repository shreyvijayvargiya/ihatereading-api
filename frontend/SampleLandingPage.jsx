import React, { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
	ArrowRight,
	ChevronDown,
	ExternalLink,
	GraduationCapIcon,
	Link,
	MenuIcon,
	X,
} from "lucide-react";
import { BsFillPencilFill } from "react-icons/bs";
import { FaGithub, FaTwitter, FaLinkedin, FaInstagram } from "react-icons/fa";
import { BsTwitterX } from "react-icons/bs";
import {
	SiNextdotjs,
	SiSupabase,
	SiFirebase,
	SiStripe,
	SiOpenai,
	SiTailwindcss,
} from "react-icons/si";
import { FaGolang } from "react-icons/fa6";
import { Code, PenToolIcon, StarIcon } from "lucide-react";

const data = {
	projectList: [
		{
			title: "E-commerce Platform",
			image:
				"https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&auto=format&fit=crop&q=60",
			link: "#",
		},
		{
			title: "Mobile Banking App",
			image:
				"https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&auto=format&fit=crop&q=60",
			link: "#",
		},
		{
			title: "Healthcare Dashboard",
			image:
				"https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&auto=format&fit=crop&q=60",
			link: "#",
		},
		{
			title: "Real Estate Platform",
			image:
				"https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=800&auto=format&fit=crop&q=60",
			link: "#",
		},
	],
	trustedCompanies: [
		{
			name: "Nextjs",
			logo: <SiNextdotjs className="w-8 h-8" />,
		},
		{
			name: "GO",
			logo: <FaGolang className="w-8 h-8" />,
		},
		{
			name: "Supabase",
			logo: <SiSupabase className="w-8 h-8" />,
		},
		{
			name: "Firebase",
			logo: <SiFirebase className="w-8 h-8" />,
		},
		{
			name: "Stripe",
			logo: <SiStripe className="w-8 h-8" />,
		},
		{
			name: "OpenAI",
			logo: <SiOpenai className="w-8 h-8" />,
		},
		{
			name: "Tailwind",
			logo: <SiTailwindcss className="w-8 h-8" />,
		},
	],
	faqs: [
		{
			question: "How long does it take to complete a project?",
			answer:
				"Typically, a complete website project takes 3-4 weeks from start to finish.",
		},
		{
			question: "What's included in your development package?",
			answer:
				"Our package includes design, development, testing, and deployment.",
		},
		{
			question: "Do you provide ongoing support?",
			answer:
				"Yes, we offer maintenance and support packages for all our clients.",
		},
		{
			question: "What payment methods do you accept?",
			answer:
				"We accept all major credit cards, PayPal, and bank transfers. We also offer flexible payment plans for larger projects.",
		},
		{
			question: "Can I make changes to my website after launch?",
			answer:
				"Yes, we provide a 30-day free revision period after launch. After that, you can opt for our maintenance package for ongoing updates.",
		},
		{
			question: "Do you offer hosting services?",
			answer:
				"Yes, we provide reliable hosting solutions with 99.9% uptime guarantee, regular backups, and 24/7 monitoring.",
		},
		{
			question: "What technologies do you use?",
			answer:
				"We use modern technologies including React, Next.js, Node.js, and various other frameworks based on project requirements.",
		},
		{
			question: "Do you provide SEO services?",
			answer:
				"Yes, we offer comprehensive SEO services including keyword research, on-page optimization, and performance tracking.",
		},
	],
	clientsData: [
		{
			name: "Sarah Johnson",
			image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330",
			testimonialMessage:
				"Working with this agency was a fantastic experience. The team delivered our project on time and exceeded our expectations with their attention to detail and communication.",
		},
		{
			name: "Michael Chen",
			image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d",
			testimonialMessage:
				"The professionalism and technical expertise were top-notch. They turned our ideas into a beautiful, functional product that our users love.",
		},
		{
			name: "Emma Wilson",
			image: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80",
			testimonialMessage:
				"From start to finish, the process was smooth and transparent. I highly recommend this team for anyone looking for quality and reliability.",
		},
	],
	workingProcess: [
		{
			step: "/001",
			label: "Blueprint",
			icon: (
				<span className="mb-2 p-2 rounded-xl bg-indigo-50">
					<Code className="w-8 h-8 text-indigo-400" />
				</span>
			),
			title: "Strategic planning to turn your idea into a launch-ready product",
			description: `We dive into your vision, users, and goals to define a clear MVP scope. You'll get a roadmap, tech stack plan, and aligned expectations — built for speed and impact.`,
		},
		{
			step: "/002",
			label: "Build",
			icon: (
				<span className="mb-2 p-2 rounded-xl bg-indigo-50">
					<PenToolIcon className="w-8 h-8 text-indigo-400" />
				</span>
			),
			title: "Design and development executed with speed and precision",
			description: `We turn the blueprint into reality using modern tools like Next.js and Supabase. Every line of code and UI element is focused on usability, speed, and functionality.`,
		},
		{
			step: "/003",
			label: "Launch",
			icon: (
				<span className="mb-2 p-2 rounded-xl bg-indigo-50">
					<StarIcon className="w-8 h-8 text-indigo-400" />
				</span>
			),
			title: "Smooth handoff with post-launch support and full ownership",
			description: `After final revisions, we deploy your MVP and hand over the repo, docs, and assets. You also get post-launch bug support to make sure everything runs clean.`,
		},
	],
	teamMembers: [
		{
			name: "Sarah Johnson",
			image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330",
		},
		{
			name: "Michael Chen",
			image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d",
		},
		{
			name: "Emma Wilson",
			image: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80",
		},
	],
	navigationLinks: [
		{ name: "About", ref: "heroRef" },
		{ name: "Projects", ref: "projectsRef" },
		{ name: "Pricing", ref: "pricingRef" },
		{ name: "How it works", ref: "workingRef" },
		{ name: "Faq", ref: "faqRef" },
		{ name: "Contact", ref: "contactRef" },
	],
	featuresRow: [
		{ text: "Quality Design" },
		{ text: "Fast MVP launch" },
		{ text: "Quick refund policy" },
	],
	hero: {
		title: "We develop fast, sleek and premium MVPs",
		subtitle: "One time payment with refund policy",
		clientsCount: "10+ satisifed clients",
		cta: {
			primary: "Book now",
			secondary: "View our Pricing",
		},
	},
	techStack: {
		title: "Teck Stack",
	},
	projects: {
		title: "Projects",
		subtitle: "Quality projects delivered on-time",
	},
	pricing: {
		title: "Pricing",
		subtitle: "One time payment, Full-stack project",
		plans: [
			{
				name: "Basic",
				price: "$3,499",
				features: [
					"Up to 5 pages",
					"Responsive design",
					"Basic SEO setup",
					"Contact form integration",
					"2 weeks delivery",
				],
				cta: "Get started",
			},
			{
				name: "Professional",
				price: "$6,499",
				features: [
					"Up to 12 pages",
					"Custom UI/UX design",
					"Advanced SEO",
					"Blog or CMS integration",
					"Payment gateway (if needed)",
					"3 weeks delivery",
				],
				cta: "Get started",
			},
		],
	},
	howItWorks: {
		title: "How it works",
		subtitle: "Easy and seamless process from request to delivery",
	},
	testimonials: {
		title: "Testimonials",
		subtitle: "Our market reviews",
	},
	faq: {
		title: "Faqs",
		subtitle: "Answers to your questions",
	},
	contact: {
		title: "Build premium MVPs in no time",
		subtitle: "Book a 15 min intro call",
		cta: "Book calendly meeting",
		message: "Feel free to contact.",
		email: "studio@agency.com",
		socialMedia: {
			title: "Social media:",
			links: [
				{ icon: <FaGithub size={24} />, label: "GitHub" },
				{ icon: <BsTwitterX size={24} />, label: "Twitter" },
				{ icon: <FaLinkedin size={24} />, label: "LinkedIn" },
			],
		},
	},
	footer: {
		copyright: "© 2025 Studio Agency. All rights reserved.",
	},
	projectDetails: {
		description:
			"Strida offers a smooth and powerful experience when presenting your work in a full-screen format. It combines bold Swiss typography, smooth animations, sidebar navigations, flexible CMS — everything to make your portfolio rock.",
		checkLink: "Check link",
		mediaSection: {
			title: "Do have look on the media",
			socialLinks: [
				{ icon: <FaGithub size={24} />, label: "GitHub" },
				{ icon: <FaTwitter size={24} />, label: "Twitter" },
				{ icon: <FaLinkedin size={24} />, label: "LinkedIn" },
				{ icon: <FaInstagram size={24} />, label: "Instagram" },
			],
		},
		projectDescriptions: [
			{
				title: "E-commerce Platform",
				description:
					"Our e-commerce platform represents a breakthrough in online shopping experiences. Built with cutting-edge technology, it offers seamless navigation, real-time inventory management, and secure payment processing.",
				features: [
					"Advanced product filtering and search capabilities",
					"Integrated payment gateways with SSL encryption",
					"Real-time inventory tracking and management",
					"Responsive design optimized for all devices",
				],
			},
			{
				title: "Mobile Banking App",
				description:
					"The mobile banking application revolutionizes how users interact with their finances. With state-of-the-art security features and intuitive design, it provides a seamless banking experience on the go.",
				features: [
					"Biometric authentication for enhanced security",
					"Real-time transaction monitoring and alerts",
					"Budget tracking and financial analytics",
					"Cross-platform compatibility (iOS & Android)",
				],
			},
			{
				title: "Healthcare Dashboard",
				description:
					"Our healthcare dashboard transforms patient care management through an intuitive interface that streamlines medical record keeping and patient monitoring.",
				features: [
					"Comprehensive patient record management",
					"Real-time health monitoring and alerts",
					"Secure HIPAA-compliant data storage",
					"Integration with medical devices and wearables",
				],
			},
			{
				title: "Real Estate Platform",
				description:
					"The real estate platform offers an immersive property viewing experience with advanced features for both buyers and sellers in the real estate market.",
				features: [
					"Virtual 3D property tours and walkthroughs",
					"Advanced property search and filtering",
					"Real-time market analysis and pricing",
					"Integrated appointment scheduling system",
				],
			},
		],
	},
};

const CheckIcon = () => (
	<svg
		className="w-5 h-5 text-zinc-600"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
	>
		<path
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			d="M5 13l4 4L19 7"
		></path>
	</svg>
);

const PricingFeature = ({ text }) => (
	<li className="flex items-center gap-3">
		<div className="bg-white border border-zinc-100 p-1 rounded-xl">
			<CheckIcon />
		</div>
		<span>{text}</span>
	</li>
);

// Section wrapper utility class
const sectionWrapper = "w-full mx-auto md:px-0 px-10 py-12 sm:py-16 md:py-10";
const sectionHeading =
	"text-2xl sm:text-3xl md:text-4xl max-w-xl mx-auto font-medium text-center mb-8 sm:mb-12";

const Idea8LandingPage = () => {
	const heroRef = useRef(null);
	const projectsRef = useRef(null);
	const pricingRef = useRef(null);
	const contactRef = useRef(null);
	const workingRef = useRef(null);
	const faqRef = useRef(null);
	const scrollContainerRef = useRef(null);
	const [selectedProject, setSelectedProject] = useState(null);
	const [activeTestimonial, setActiveTestimonial] = useState(0);

	// Handle modal scroll lock separately since it depends on selectedProject

	const scrollToSection = (ref) => {
		if (!ref || !ref.current) return;

		const element = ref.current;
		const navbarHeight = 80; // Height of the navbar

		// Get the element's position relative to the viewport
		const elementPosition = element.getBoundingClientRect().top;
		const offsetPosition = elementPosition + window.scrollY - navbarHeight;

		setIsMenuOpen(false);
		// Use native smooth scrolling
		window.scrollTo({
			top: offsetPosition,
			behavior: "smooth",
		});
	};

	const getRefByName = (refName) => {
		const refs = {
			heroRef,
			projectsRef,
			pricingRef,
			workingRef,
			faqRef,
			contactRef,
		};
		return refs[refName];
	};

	const openModal = (project) => {
		setSelectedProject(project);
	};

	const closeModal = () => {
		setSelectedProject(null);
	};

	const [isMenuOpen, setIsMenuOpen] = useState(false);

	return (
		<div className="relative bg-zinc-50/80">
			{/* Main content container with scroll behavior */}
			<div className="z-50 md:max-w-5xl max-w-lg mx-auto border-l border-r border-zinc-100 scroll-container">
				{/* Navbar */}
				<nav
					className={`fixed top-0 left-0 right-0 px-4 sm:px-6 lg:px-8 flex items-center justify-between md:max-w-5xl max-w-lg mx-auto py-4 z-20 border-b border-l border-r border-zinc-100 bg-zinc-50 transition-all duration-300 ease-out`}
				>
					{/* Logo */}
					<div className="flex-shrink-0 md:gap-0 sm:gap-4 flex items-center">
						{/* Navigation Links */}
						<div className="">
							{isMenuOpen ? (
								<X
									className="md:hidden"
									onClick={() => setIsMenuOpen(!isMenuOpen)}
								/>
							) : (
								<MenuIcon
									className="md:hidden text-zinc-900"
									onClick={() => setIsMenuOpen(!isMenuOpen)}
								/>
							)}
							{isMenuOpen && (
								<motion.div
									initial={{ opacity: 0, y: -40 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -10 }}
									transition={{ duration: 0.3 }}
									className="fixed inset-0 bg-zinc-100/90 backdrop-blur-sm z-50 flex items-center justify-center flex-col p-4 overflow-y-auto"
								>
									<div className="flex items-center justify-end gap-10">
										<button
											onClick={() => setIsMenuOpen(false)}
											className="absolute top-10 right-10 p-2 bg-white hover:scale-105 transition-all duration-100 ease-in rounded-full"
										>
											<X className="w-6 h-6" />
										</button>
									</div>
									{data.navigationLinks.map((link, index) => (
										<button
											key={index}
											onClick={() => scrollToSection(getRefByName(link.ref))}
											className="text-zinc-900 hover:text-black px-3 py-2 font-medium text-2xl"
										>
											{link.name}
										</button>
									))}
								</motion.div>
							)}
						</div>
						<a
							href="/"
							className="flex gap-2 items-center md:text-xl text-lg font-medium hover:underline"
						>
							<span className="p-2 rounded-xl bg-zinc-800 shadow-xl text-zinc-200">
								<BsFillPencilFill size={18} />
							</span>
							Studio
						</a>
					</div>

					{/* Navigation Links */}
					<div className="hidden md:flex md:ml-10 items-center space-x-2">
						{data.navigationLinks.map((link, index) => (
							<button
								key={index}
								onClick={() => scrollToSection(getRefByName(link.ref))}
								className="text-zinc-800 hover:text-black px-3 py-2 md:text-sm text-xs font-medium"
							>
								{link.name}
							</button>
						))}
					</div>
					{/* Connect Button */}
					<button
						onClick={() => scrollToSection(contactRef)}
						className="relative flex items-center justify-center text-center overflow-hidden bg-black text-white ring-2 ring-zinc-700 px-4 py-2 rounded-full text-sm font-medium group"
					>
						<span className="relative z-10">Connect now</span>
						<ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-all duration-300 ease-in" />
						<div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-gradient-x" />
					</button>
				</nav>

				{/* Hero Section */}
				<section
					ref={heroRef}
					className={`${sectionWrapper} flex flex-col items-center justify-center`}
				>
					<div className="flex items-center justify-center px-8 flex-col mt-20">
						<div className="flex gap-2 border border-zinc-100 rounded-full py-2 px-4 bg-white mx-auto">
							<div className="flex -space-x-2">
								{data.clientsData.map((member, index) => (
									<img
										key={index}
										src={member.image}
										alt={`Team member ${member.name}`}
										className="w-6 h-6 object-cover hover:translate-y-1 transition-all duration-100 ease-in rounded-full border-2 border-white"
										title={member.name}
									/>
								))}
							</div>
							<p className="text-zinc-400 text-sm mt-0.5">
								{data.hero.clientsCount}
							</p>
						</div>
						<div className="text-center space-y-10">
							<motion.h1
								initial={{ opacity: 0, y: 20 }}
								animate={{ opacity: 1, y: 0 }}
								className="text-6xl my-2"
							>
								<p className="text-[4rem] font-sans font-medium text-zinc-800 max-w-xl mx-auto break-words">
									{data.hero.title}
								</p>
							</motion.h1>
							<div className="flex items-center justify-center gap-4 flex-wrap ">
								<motion.button
									initial={{ opacity: 0, y: 20 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ delay: 0.4 }}
									className="relative flex items-center justify-center text-center overflow-hidden bg-black text-white ring-2 ring-zinc-700 px-4 py-2 rounded-full text-sm font-medium group"
								>
									<span className="relative z-10">{data.hero.cta.primary}</span>
									<ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-all duration-300 ease-in" />
									<div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-gradient-x" />
								</motion.button>
								<motion.button
									initial={{ opacity: 0, y: 20 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ delay: 0.4 }}
									className="border border-zinc-50 hover:bg-zinc-100 hover:ring-2 ring-zinc-100 bg-white text-black px-4 py-2 rounded-full transition-all duration-300 ease-in"
								>
									{data.hero.cta.secondary}
								</motion.button>
							</div>
							<motion.p
								initial={{ opacity: 0, y: 20 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ delay: 0.2 }}
								className="mb-8 max-w-sm mx-auto text-zinc-600 text-center"
							>
								{data.hero.subtitle}
							</motion.p>
						</div>
					</div>
				</section>

				{/* About Stack */}
				<section className={sectionWrapper}>
					<div className="border-t border-b border-zinc-100 ">
						{/* Features Row */}
						<section className="w-full flex flex-wrap justify-center items-center gap-6 md:divide-x md:divider-zinc-50">
							{data.featuresRow.map((feature, idx) => (
								<div key={idx} className="flex items-center gap-2 px-4 py-2">
									<div className="border border-zinc-100 p-1 rounded-xl">
										<CheckIcon size={18} />
									</div>
									<span className="font-bold text-zinc-500 text-base">
										{feature.text}
									</span>
								</div>
							))}
						</section>
					</div>
				</section>

				{/* Tech Stack */}
				<section className={sectionWrapper}>
					<div className="overflow-hidden max-w-7xl mx-auto">
						<div className="flex justify-center items-center gap-2 mb-4">
							<div className="w-2 h-2 rounded-full bg-indigo-400" size={60} />
							<p className="text-zinc-700">{data.techStack.title}</p>
						</div>
						<motion.div
							ref={scrollContainerRef}
							className="flex flex-wrap gap-8 whitespace-nowrap justify-center items-center mx-auto"
						>
							{data.trustedCompanies.map((company, index) => (
								<div
									key={index}
									className={`relative group cursor-pointer rounded-xl p-5 transition-opacity duration-300 flex flex-col justify-center items-center gap-2`}
								>
									{company.logo}
									<span className="text-xs">{company.name}</span>
								</div>
							))}
						</motion.div>
					</div>
				</section>

				{/* Recent Projects */}
				<section ref={projectsRef} className={sectionWrapper}>
					<div className="max-w-7xl mx-auto relative z-10">
						<div className="flex justify-center items-center gap-2 mb-4">
							<div className="w-2 h-2 rounded-full bg-indigo-400" size={60} />
							<p className="text-zinc-700">{data.projects.title}</p>
						</div>
						<h2 className="text-4xl text mb-10 text-center font-medium">
							{data.projects.subtitle}
						</h2>

						{/* Original Grid Layout */}
						<div className="grid grid-cols-1 md:grid-cols-2 gap-8 px-8">
							{data.projectList.map((project, index) => (
								<div key={index}>
									<motion.div
										key={index}
										initial={{ opacity: 0, y: 20 }}
										whileInView={{ opacity: 1, y: 0 }}
										transition={{ delay: index * 0.1 }}
										className="relative group cursor-pointer rounded-xl p-1 ring-2 ring-zinc-100 hover:ring-4 hover:ring-zinc-100 transition-all duration-300 ease-in bg-white"
										onClick={() => openModal(project)}
									>
										<img
											src={project.image}
											alt={project.title}
											className="w-full md:h-[20rem] h-auto object-cover object-top rounded-xl group-hover:object-center transition-all duration-300 ease-in"
										/>
									</motion.div>
									<p className="text-xl text-zinc-400 my-4 text-center">
										{project.title}
									</p>
								</div>
							))}
						</div>
					</div>
				</section>

				{/* Project Modal */}
				<AnimatePresence>
					{selectedProject && (
						<motion.div
							initial={{ opacity: 0, y: "-100%" }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0 }}
							className="fixed inset-0 bg-zinc-100/50 backdrop-blur-xl z-50 flex items-start justify-center p-4 overflow-y-auto"
							onClick={closeModal}
						>
							<motion.div
								initial={{ scale: 0.9, opacity: 0 }}
								animate={{ scale: 1, opacity: 1 }}
								exit={{ scale: 0.9, opacity: 0 }}
								transition={{ duration: 0.2 }}
								className="w-full max-h-[90vh] mx-auto rounded-xl relative my-8"
								onClick={(e) => e.stopPropagation()}
							>
								<div className="p-6 z-50 max-w-4xl mx-auto">
									<div className="flex items-center justify-end gap-10">
										<button
											onClick={closeModal}
											className="p-2 bg-white hover:scale-105 transition-all duration-100 ease-in rounded-full"
										>
											<X className="w-6 h-6" />
										</button>
									</div>
								</div>
								<div className="md:p-20 p-10 max-w-4xl mx-auto bg-white rounded-2xl">
									<div className="flex flex-col gap-8">
										<h3 className="text-4xl font-light text-black">
											{selectedProject.title}
										</h3>
										<p className="text-zinc-600 text-lg">
											{data.projectDetails.description}
										</p>
										<button
											onClick={() => scrollToSection(contactRef)}
											className="flex items-center ring-4 ring-zinc-100 justify-center w-40 gap-2 relative overflow-hidden bg-zinc-800 text-white px-2 py-2 rounded-full text-sm font-medium group"
										>
											<Link size={20} />
											<span className="relative z-10">
												{data.projectDetails.checkLink}
											</span>
											<div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-gradient-x" />
										</button>
										<div className="flex flex-col gap-12">
											{data.projectList.slice(0, 4).map((project, index) => (
												<div key={index} className="flex flex-col gap-6 my-5">
													<img
														src={project.image}
														alt={project.title}
														className="w-full h-[500px] object-cover rounded-xl hover:scale-[1.02] transition-transform duration-500"
													/>
													<div className="space-y-4 max-w-3xl">
														<h3 className="text-3xl font-semibold text-zinc-800">
															{project.title}
														</h3>
														<div className="space-y-4 text-zinc-600">
															<p className="text-lg leading-relaxed">
																{
																	data.projectDetails.projectDescriptions[index]
																		.description
																}
															</p>
															<ul className="list-disc pl-6 space-y-2">
																{data.projectDetails.projectDescriptions[
																	index
																].features.map((feature, idx) => (
																	<li key={idx}>{feature}</li>
																))}
															</ul>
														</div>
													</div>
												</div>
											))}
										</div>
										<div className="flex justify-start space-x-6 mb-10">
											<p>{data.projectDetails.mediaSection.title}</p>
											{data.projectDetails.mediaSection.socialLinks.map(
												(link, index) => (
													<div key={index} className="relative group">
														<a
															href="#"
															className="text-zinc-600 hover:text-zinc-800 transition-colors duration-300"
														>
															{link.icon}
														</a>
														<div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-zinc-50 text-zinc-600 px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
															{link.label}
														</div>
													</div>
												),
											)}
										</div>
									</div>
								</div>
							</motion.div>
						</motion.div>
					)}
				</AnimatePresence>

				{/* Pricing Section */}
				<section ref={pricingRef} className={sectionWrapper}>
					<div className="flex justify-center items-center gap-2 mb-4">
						<div className="w-2 h-2 rounded-full bg-indigo-400" />
						<p className="text-zinc-700">{data.pricing.title}</p>
					</div>
					<h2 className="md:text-4xl text-2xl mb-5 text-center font-medium max-w-xl mx-auto">
						{data.pricing.subtitle}
					</h2>
					<motion.div
						initial={{ opacity: 0.5 }}
						whileInView={{ opacity: 1 }}
						transition={{ duration: 0.3, ease: "easeInOut" }}
						className="grid grid-cols-1 sm:grid-cols-2 gap-8 p-8 mx-0"
					>
						{data.pricing.plans.map((plan, index) => (
							<div
								key={index}
								className="p-8 bg-white ring-2 ring-zinc-100 hover:shadow-2xl hover:ring-4 transition-all duration-100 ease-in rounded-2xl"
							>
								<div className="flex gap-2 mb-2">
									{index === 0 ? (
										<SiSupabase size={18} className="text-zinc-700" />
									) : (
										<GraduationCapIcon size={18} className="text-zinc-700" />
									)}
									<h3 className="font-light">{plan.name}</h3>
								</div>
								<p className="text-4xl mb-4">{plan.price}</p>
								<ul className="text-left mb-8 space-y-4">
									{plan.features.map((feature, idx) => (
										<PricingFeature key={idx} text={feature} />
									))}
								</ul>
								<button className="relative flex items-center justify-center gap-1 text-center overflow-hidden bg-black text-white ring-2 ring-zinc-700 px-4 py-2 rounded-full text-sm font-medium group">
									<span className="relative z-10">{plan.cta}</span>
									<ExternalLink className="w-4 h-4 group-hover:translate-x-1 transition-all duration-300 ease-in" />
									<div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-gradient-x" />
								</button>
							</div>
						))}
					</motion.div>
				</section>

				{/* How it works Section */}
				<section className={`${sectionWrapper} bg-white`} ref={workingRef}>
					<div className="flex items-center justify-center gap-2 mb-4">
						<div className="w-2 h-2 rounded-full bg-indigo-400" />
						<span className="text-zinc-700">{data.howItWorks.title}</span>
					</div>
					<h2 className={sectionHeading}>{data.howItWorks.subtitle}</h2>
					<div className="flex flex-col gap-12 my-5 max-w-2xl mx-auto">
						{data.workingProcess.map((step, idx) => (
							<div
								key={idx}
								className="flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-8 my-4"
							>
								<div className="flex flex-col items-center md:items-end mb-4 md:mb-0">
									{step.icon}
									<span className="text-zinc-400 font-mono text-lg mb-2">
										{step.step}
									</span>
									<span className="bg-zinc-100 text-zinc-500 px-4 py-1 rounded-full text-xs font-semibold mb-2">
										{step.label}
									</span>
								</div>
								<div className="flex-1">
									<h3 className="text-xl sm:text-2xl font-semibold mb-2">
										{step.title}
									</h3>
									<p className="text-zinc-500 max-w-2xl text-base sm:text-lg">
										{step.description}
									</p>
								</div>
							</div>
						))}
					</div>
				</section>

				{/* Testimonials Section */}
				<section className={sectionWrapper}>
					<div className="flex justify-center items-center gap-2 mb-4">
						<div className="w-2 h-2 rounded-full bg-indigo-400" />
						<p className="text-zinc-700">{data.testimonials.title}</p>
					</div>
					<h2 className="md:text-4xl text-2xl font-medium text-center">
						{data.testimonials.subtitle}
					</h2>
					<div className="flex space-x-2 justify-center my-8">
						{data.clientsData.map((member, index) => (
							<button
								key={index}
								onClick={() => setActiveTestimonial(index)}
								className={`focus:outline-none rounded-full border-2 transition-all duration-200 ${
									activeTestimonial === index
										? "border-indigo-400 scale-100 opacity-100 bg-white"
										: "border-white bg-transparent scale-95 opacity-90"
								}`}
							>
								<img
									src={member.image}
									alt={`Team member ${member.name}`}
									className={`w-12 h-12 object-cover rounded-full ${
										activeTestimonial === index
											? "ring-4 ring-indigo-400 scale-100 opacity-100"
											: "scale-95 opacity-90"
									} transition-all duration-200`}
									title={member.name}
								/>
							</button>
						))}
					</div>
					<div className="max-w-lg mx-auto text-center mt-6 bg-white p-6 rounded-xl ring-4 ring-zinc-100 max-h-96 overflow-y-auto hidescrollbar">
						<p className="text-lg italic text-zinc-700 mb-4 max-w-xl mx-auto">
							"{data.clientsData[activeTestimonial].testimonialMessage}"
						</p>
						<p className="font-semibold text-zinc-900">
							{data.clientsData[activeTestimonial].name}
						</p>
					</div>
				</section>

				{/* FAQs Section */}
				<section ref={faqRef} className={`${sectionWrapper}`}>
					<div className="flex justify-center items-center mb-4 gap-4">
						<div className="w-2 h-2 rounded-full bg-indigo-400" />
						<p className="text-zinc-700">{data.faq.title}</p>
					</div>
					<h2 className="md:text-4xl text-2xl font-medium font-sans md:mb-20 mb-10 text-center">
						{data.faq.subtitle}
					</h2>
					<div className="max-w-xl mx-auto gap-10 flex flex-col justify-center items-center break-words">
						<div className="space-y-4 flex-1 order-1 md:order-2 w-full">
							{data.faqs.map((faq, index) => (
								<details
									key={index}
									className="border border-zinc-200 p-4 transition-all duration-300 group rounded-xl w-full"
								>
									<summary className="w-full flex justify-between items-center cursor-pointer list-none">
										<span className="text-lg">{faq.question}</span>
										<ChevronDown className="w-5 h-5 text-zinc-600 group-open:rotate-180 transition-transform duration-300" />
									</summary>
									<p className="mt-2 text-zinc-600 max-w-4xl mx-auto">
										{faq.answer}
									</p>
								</details>
							))}
						</div>
					</div>
				</section>

				{/* Let's Connect Section */}
				<section
					className={`${sectionWrapper} pt-20 pb-10 bg-white`}
					ref={contactRef}
				>
					<motion.div
						className="mx-auto md:px-8 text-center relative z-10"
						whileInView={{ opacity: 1, scale: 1, y: 0 }}
						initial={{ opacity: 0, scale: 0.98, y: 100 }}
						exit={{ opacity: 0, scale: 0.98, y: -100 }}
						transition={{ duration: 0.8, ease: "easeOut" }}
					>
						<div className="text-center flex justify-around flex-wrap-reverse md:flex-nowrap items-start gap-10">
							<div className="max-w-lg text-left">
								<a
									href="/"
									className="flex gap-2 items-center md:text-xl text-xl font-medium hover:underline mb-10"
								>
									<span className="p-2 rounded-xl bg-zinc-800 shadow-xl text-zinc-200">
										<BsFillPencilFill size={18} />
									</span>
									<p>Studio</p>
								</a>
								<p className="md:text-5xl text-2xl font-light">
									{data.contact.title}
								</p>
								<div className="flex justify-start flex-wrap gap-6 mt-10">
									<p>{data.contact.socialMedia.title}</p>
									{data.contact.socialMedia.links.map((link, index) => (
										<div key={index} className="relative group">
											<a href="#">{link.icon}</a>
										</div>
									))}
								</div>
							</div>
							<div className="max-w-lg bg-zinc-50 p-10 text-left rounded-2xl ring-4 ring-zinc-100">
								<p className="text-3xl font-light my-4 text-left">
									{data.contact.subtitle}
								</p>
								<button className="relative flex items-center justify-center text-center overflow-hidden bg-black text-white ring-2 ring-zinc-700 px-4 py-2 rounded-full text-sm font-medium group">
									<span className="relative z-10">{data.contact.cta}</span>
									<ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-all duration-300 ease-in" />
									<div className="absolute inset-0 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-500 animate-gradient-x" />
								</button>
								<br />
								<p className="text-zinc-700 font-light md:mb-40 max-w-md mx-auto">
									{data.contact.message}
								</p>
								<div>
									Email us at{" "}
									<a className="text-zinc-800 hover:text-zinc-900 hover:underline font-medium cursor-pointer">
										{data.contact.email}
									</a>
								</div>
							</div>
						</div>
					</motion.div>
					<div className="p-2 text-center border-t border-zinc-50 mt-10">
						<p className="mt-8 text-zinc-400">{data.footer.copyright}</p>
					</div>
				</section>
			</div>
		</div>
	);
};

export default Idea8LandingPage;
