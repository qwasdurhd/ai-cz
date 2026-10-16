declare module "arabic-reshaper" {
  const reshaper: { convertArabic: (text: string) => string; convertArabicBack: (text: string) => string };
  export default reshaper;
}