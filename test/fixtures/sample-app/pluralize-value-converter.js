export class PluralizeValueConverter {
  toView(count, word) {
    return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
  }
}
