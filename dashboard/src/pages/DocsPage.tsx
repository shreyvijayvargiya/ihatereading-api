import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import docs from "../../../scrape-agents-docs.md?raw";
import { Card, CardContent } from "@/components/ui/card";

export function DocsPage() {
	return (
		<Card className="h-full overflow-hidden">
			<CardContent className="h-full overflow-auto p-6">
				<article className="docs-prose">
					<Markdown remarkPlugins={[remarkGfm]}>{docs}</Markdown>
				</article>
			</CardContent>
		</Card>
	);
}
