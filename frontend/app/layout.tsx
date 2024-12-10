import "../styles.css";
import Link from "next/link";
import React from "react";
import { Button } from "./components/ui/button";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: "3rem",
        }}
      >
        <header>
          <Link href="/">Home</Link>
          {" | "}
          <Link href="/posts">Posts</Link>
        </header>
        <main>{children}</main>
        <Button>Click me</Button>
      </body>
    </html>
  );
}
