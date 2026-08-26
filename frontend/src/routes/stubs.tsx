import { useNodeConfig } from "../lib/config";

/** Placeholder pages gated by config.features.pages. */
function StubPage({ title }: { title: string }) {
  const { data: config } = useNodeConfig();
  return (
    <div className="mx-auto max-w-3xl py-6">
      <h1 className="mb-3 text-xl font-semibold text-gray-900">{title}</h1>
      <p className="text-sm text-[#555555]">
        This {config?.key ?? "FIESTA"} page is coming soon. In the meantime, please see{" "}
        {config?.links.website ? (
          <a href={config.links.website} className="text-node hover:underline">
            the {config.key} website
          </a>
        ) : (
          "the node website"
        )}{" "}
        or{" "}
        <a
          href={`mailto:${config?.contact_email ?? "webmaster@earthref.org"}`}
          className="text-node hover:underline"
        >
          email us
        </a>{" "}
        with any questions.
      </p>
    </div>
  );
}

export function AboutPage() {
  return <StubPage title="About" />;
}

export function TechnologyPage() {
  return <StubPage title="Technology" />;
}

export function GrandChallengesPage() {
  return <StubPage title="Grand Challenges" />;
}

export function WorkshopsPage() {
  return <StubPage title="Workshops" />;
}

export function LinksPage() {
  return <StubPage title="Links" />;
}

export function HelpPage() {
  return <StubPage title="Help" />;
}
