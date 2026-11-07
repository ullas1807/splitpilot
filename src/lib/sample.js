// Built-in sample receipt so anyone (e.g., judges) can try the flow without a photo.
export const SAMPLE_RECEIPT = {
  venue: 'Demo Bistro',
  items: [
    { name: 'Margherita Pizza', quantity: 1, line_total: 14.0 },
    { name: 'Paneer Tikka', quantity: 1, line_total: 11.5 },
    { name: 'Pasta Alfredo', quantity: 1, line_total: 13.0 },
    { name: 'Garlic Bread', quantity: 1, line_total: 6.5 },
    { name: 'Lemonade', quantity: 3, line_total: 9.0 },
  ],
  tax: 4.32,
  tip: 8.0,
  lat: 37.7749,
  lng: -122.4194,
};
