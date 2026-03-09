"use client";

import styles from "./logo.module.css";

export function Logo({ showVersion = true }: { showVersion?: boolean }) {
    return (
        <div className={styles.wrapper}>
            <svg
                className={styles.dove}
                viewBox="0 0 750 700"
                xmlns="http://www.w3.org/2000/svg"
            >
                <defs>
                    <linearGradient id="logo-gradient" x1="10%" y1="100%" x2="90%" y2="0%">
                        <stop offset="0%" stopColor="#2543A8" />
                        <stop offset="35%" stopColor="#4F46E5" />
                        <stop offset="70%" stopColor="#A855F7" />
                        <stop offset="100%" stopColor="#D946EF" />
                    </linearGradient>
                </defs>
                <path
                    className={styles.dove__path}
                    d="
            M 552,210
            L 599,210
            L 678,271
            L 588,274
            L 539,456
            L 312,565
            L 260,635
            L 135,591
            L 357,465
            L 376,421
            L 466,290
            Z

            M 357,465 L 539,456
            M 357,465 L 312,565

            M 466,290 L 299,70 L 287,226 Z

            M 287,226
            L 89,115
            L 228,365
            L 376,421
            Z

            M 228,365
            L 168.23,257.5
            L 316.23,313.5
            L 376,421
          "
                />
            </svg>
            <span className={styles.wordmark}>
                aacyn
                {showVersion && <span className={styles.version}>v0.9.0</span>}
            </span>
        </div>
    );
}
