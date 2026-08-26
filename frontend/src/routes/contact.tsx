import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useNodeConfig } from "../lib/config";

export function ContactPage() {
  const { data: config } = useNodeConfig();

  return (
    <div className="mx-auto max-w-lg py-6">
      <h1 className="mb-5 text-xl font-semibold text-gray-900">Contact</h1>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">
              Questions about {config?.key}, your contributions, or your account:
            </p>
            <a
              href={`mailto:${config?.contact_email}`}
              className="mt-1 inline-block text-sm font-medium text-node hover:underline"
            >
              {config?.contact_email}
            </a>
          </CardContent>
        </Card>
        {config?.links.github_issues && (
          <Card>
            <CardHeader>
              <CardTitle>Report an issue</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600">
                Found a bug or have a feature request? Open an issue on GitHub:
              </p>
              <a
                href={config.links.github_issues}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block break-all text-sm font-medium text-node hover:underline"
              >
                {config.links.github_issues}
              </a>
            </CardContent>
          </Card>
        )}
        {config?.links.website && (
          <Card>
            <CardHeader>
              <CardTitle>Website</CardTitle>
            </CardHeader>
            <CardContent>
              <a
                href={config.links.website}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-node hover:underline"
              >
                {config.links.website}
              </a>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
