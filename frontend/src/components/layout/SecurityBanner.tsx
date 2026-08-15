import { MessageSquare, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function ScanRepositoryButton({ onClick }: { onClick?: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<ScanLine className="h-3.5 w-3.5" />}
      onClick={onClick}
    >
      Scan Repository
    </Button>
  );
}

export function FeedbackButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<MessageSquare className="h-3.5 w-3.5" />}
    >
      Feedback
    </Button>
  );
}
