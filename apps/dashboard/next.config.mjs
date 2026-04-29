/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['db', 'ai', 'meta'],
};

export default nextConfig;
