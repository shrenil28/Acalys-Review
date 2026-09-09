import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { AreaTrend, series } from "@/components/charts/Charts";
import { weeklyReviews } from "@/data/analytics";

/** Explicit demo-mode chart. API mode never loads this fixture module. */
export function RepositoryWeeklyReviewsFixture() {
  return (
    <Card>
      <CardHeader title="Weekly reviews" />
      <CardBody>
        <AreaTrend
          data={weeklyReviews}
          seriesDefs={[{ key: "value", label: "Reviews", color: series.brand }]}
        />
      </CardBody>
    </Card>
  );
}
