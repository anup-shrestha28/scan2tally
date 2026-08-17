function getReceiptPageItems(currentPage, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'end-ellipsis', pageCount];
  if (currentPage >= pageCount - 3) {
    return [1, 'start-ellipsis', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }
  return [1, 'start-ellipsis', currentPage - 1, currentPage, currentPage + 1, 'end-ellipsis', pageCount];
}
console.log("7, 7:", getReceiptPageItems(7, 7));
console.log("8, 7:", getReceiptPageItems(8, 7));
console.log("7, 8:", getReceiptPageItems(7, 8));
console.log("8, 8:", getReceiptPageItems(8, 8));
