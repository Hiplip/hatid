export const metadata = { title: "hatid example" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: "system-ui", margin: 0 }}>{children}</body></html>;
}
