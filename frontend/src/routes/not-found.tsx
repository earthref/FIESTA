import { Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="text-5xl font-bold text-node">404</p>
      <h1 className="mt-3 text-lg font-semibold text-gray-900">Page not found</h1>
      <p className="mt-2 text-sm text-gray-600">
        The page you are looking for does not exist or has moved.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Link to="/">
          <Button variant="secondary">Home</Button>
        </Link>
        <Link to="/search">
          <Button>Search</Button>
        </Link>
      </div>
    </div>
  );
}
