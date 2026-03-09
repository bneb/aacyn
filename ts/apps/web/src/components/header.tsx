"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import styles from "./header.module.css";

const NAV_LINKS = [
    { href: "/compare", label: "Compare" },
    { href: "/benchmarks", label: "Benchmarks" },
    { href: "/docs", label: "Docs" },
];

export function Header() {
    const pathname = usePathname();

    return (
        <nav className={styles.nav}>
            <Link href="/" className={styles.nav__brand}>
                <Logo />
            </Link>
            <div className={styles.nav__links}>
                {NAV_LINKS.map((link) => (
                    <Link
                        key={link.href}
                        href={link.href}
                        className={`${styles.nav__link} ${pathname === link.href ? styles.nav__linkActive : ""}`}
                    >
                        {link.label}
                    </Link>
                ))}
            </div>
        </nav>
    );
}
